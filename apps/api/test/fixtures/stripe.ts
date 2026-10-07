// Test fixture: API'nin ve `mppx`'in kullandığı Stripe REST uçlarını bellekteki nesnelerle yanıtlayan yerel HTTP
// sunucusu. API gerçek `stripe` SDK'sıyla konuşur (form kodlu gövde, `Idempotency-Key`, hata zarfı). Gerçek Stripe
// test moduyla deneme `fiat-devnet.e2e.test.ts`'tedir.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type Obj = Record<string, unknown>;

/** Stripe'ın form kodlaması (`a[b][0]=c`) → iç içe nesne; sayısal anahtarlar dizi olur. */
export function parseForm(body: string): Obj {
  const root: Obj = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const path = rawKey.replace(/\]/g, '').split('[');
    let node: Obj = root;
    path.forEach((part, index) => {
      const last = index === path.length - 1;
      const key = part === '' ? String(Object.keys(node).length) : part;
      if (last) node[key] = value;
      else node = (node[key] ??= {}) as Obj;
    });
  }
  const arrays = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    const entries = Object.entries(value as Obj).map(([k, v]) => [k, arrays(v)] as const);
    return entries.length > 0 && entries.every(([k], i) => k === String(i))
      ? entries.map(([, v]) => v)
      : Object.fromEntries(entries);
  };
  return arrays(root) as Obj;
}

export interface StripeRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Obj;
  readonly headers: IncomingMessage['headers'];
}

export class StripeFixture {
  private sequence = 0;
  readonly customers = new Map<string, Obj>();
  readonly setupIntents = new Map<string, Obj>();
  readonly paymentIntents = new Map<string, Obj>();
  readonly paymentMethods = new Map<string, Obj>();
  readonly refunds: Obj[] = [];
  readonly requests: StripeRequest[] = [];
  private readonly idempotent = new Map<string, { status: number; body: Obj }>();
  /** Reddedilen kartlar (off-session) ve SPT'ler: `card_declined`. */
  readonly declining = new Set<string>();
  /** Müşterinin onayını isteyen kartlar: `authentication_required`. */
  readonly authenticationRequired = new Set<string>();
  /** Sonraki isteklere verilecek HTTP durumu (Stripe'a ulaşılamıyor); null normal yanıt. */
  failWith: number | null = null;
  /** Charge'ların anı (unix saniyesi). */
  now = () => Math.floor(Date.now() / 1000);

  private id(prefix: string) {
    this.sequence += 1;
    return `${prefix}_fx${this.sequence.toString().padStart(6, '0')}`;
  }

  reset(): void {
    for (const map of [this.customers, this.setupIntents, this.paymentIntents, this.paymentMethods]) map.clear();
    this.refunds.length = 0;
    this.requests.length = 0;
    this.idempotent.clear();
    this.declining.clear();
    this.authenticationRequired.clear();
    this.failWith = null;
  }

  /** Kayıtlı kart (Stripe.js'in SetupIntent onayıyla oluşan). */
  card(last4 = '4242'): string {
    const id = this.id('pm');
    this.paymentMethods.set(id, {
      id,
      object: 'payment_method',
      type: 'card',
      customer: null,
      card: { brand: 'visa', last4, exp_month: 12, exp_year: 2031 },
    });
    return id;
  }

  /** Tarayıcının `confirmCardSetup`'ı: SetupIntent başarılı, kart müşteriye bağlı. */
  confirmSetup(setupIntent: string, paymentMethod: string): Obj {
    const setup = this.setupIntents.get(setupIntent)!;
    Object.assign(setup, { status: 'succeeded', payment_method: paymentMethod });
    this.paymentMethods.get(paymentMethod)!['customer'] = setup['customer'];
    return setup;
  }

  /** Tarayıcının `confirmCardPayment`'ı: PaymentIntent başarılı, charge oluştu. */
  confirmPayment(paymentIntent: string, paymentMethod = this.card()): Obj {
    const pi = this.paymentIntents.get(paymentIntent)!;
    return this.succeed(pi, paymentMethod);
  }

  private succeed(pi: Obj, paymentMethod: string): Obj {
    return Object.assign(pi, {
      status: 'succeeded',
      payment_method: paymentMethod,
      latest_charge: this.id('ch'),
      charge_created: this.now(),
    });
  }

  private view(pi: Obj, expand: boolean): Obj {
    const { charge_created: created, ...rest } = pi;
    if (!expand || !pi['latest_charge']) return rest;
    return { ...rest, latest_charge: { id: pi['latest_charge'], object: 'charge', created } };
  }

  private cardError(pi: Obj, code: string, declineCode: string | null): { status: number; body: Obj } {
    return {
      status: 402,
      body: {
        error: {
          type: 'card_error',
          code,
          ...(declineCode ? { decline_code: declineCode } : {}),
          message: code,
          payment_intent: this.view(pi, false),
        },
      },
    };
  }

  private createPaymentIntent(body: Obj): { status: number; body: Obj } {
    const id = this.id('pi');
    const pi: Obj = {
      id,
      object: 'payment_intent',
      amount: Number(body['amount']),
      currency: body['currency'],
      customer: body['customer'] ?? null,
      metadata: body['metadata'] ?? {},
      payment_method: body['payment_method'] ?? null,
      client_secret: `${id}_secret_fx`,
      status: 'requires_payment_method',
      latest_charge: null,
    };
    this.paymentIntents.set(id, pi);
    if (body['confirm'] !== 'true') return { status: 200, body: this.view(pi, false) };
    const instrument = String(body['payment_method'] ?? body['shared_payment_granted_token']);
    if (this.declining.has(instrument)) return this.cardError(pi, 'card_declined', 'insufficient_funds');
    if (this.authenticationRequired.has(instrument)) {
      pi['status'] = 'requires_action';
      return this.cardError(pi, 'authentication_required', 'authentication_required');
    }
    return { status: 200, body: this.view(this.succeed(pi, instrument), false) };
  }

  handle(method: string, path: string, query: URLSearchParams, body: Obj): { status: number; body: Obj } {
    const notFound = { status: 404, body: { error: { type: 'invalid_request_error', message: 'No such object' } } };
    let match: RegExpExecArray | null;
    if (method === 'POST' && path === '/v1/customers') {
      const id = this.id('cus');
      const customer = { id, object: 'customer', metadata: body['metadata'] ?? {} };
      this.customers.set(id, customer);
      return { status: 200, body: customer };
    }
    if (method === 'POST' && path === '/v1/setup_intents') {
      const id = this.id('seti');
      const setup = {
        id,
        object: 'setup_intent',
        customer: body['customer'],
        usage: body['usage'],
        metadata: body['metadata'] ?? {},
        client_secret: `${id}_secret_fx`,
        status: 'requires_payment_method',
        payment_method: null,
      };
      this.setupIntents.set(id, setup);
      return { status: 200, body: setup };
    }
    if (method === 'POST' && path === '/v1/payment_intents') return this.createPaymentIntent(body);
    if (method === 'GET' && (match = /^\/v1\/payment_intents\/([^/]+)$/.exec(path))) {
      const pi = this.paymentIntents.get(match[1]!);
      const expand = [...query].filter(([key]) => /^expand\[\d*\]$/.test(key)).map(([, value]) => value);
      return pi ? { status: 200, body: this.view(pi, expand.includes('latest_charge')) } : notFound;
    }
    if (method === 'GET' && (match = /^\/v1\/payment_methods\/([^/]+)$/.exec(path))) {
      const pm = this.paymentMethods.get(match[1]!);
      return pm ? { status: 200, body: pm } : notFound;
    }
    if (method === 'POST' && (match = /^\/v1\/payment_methods\/([^/]+)\/detach$/.exec(path))) {
      const pm = this.paymentMethods.get(match[1]!);
      if (!pm) return notFound;
      pm['customer'] = null;
      return { status: 200, body: pm };
    }
    if (method === 'POST' && path === '/v1/refunds') {
      const refund = { id: this.id('re'), object: 'refund', status: 'succeeded', ...body };
      this.refunds.push(refund);
      return { status: 200, body: refund };
    }
    return notFound;
  }

  /** İsteğin yanıtı; `Idempotency-Key` aynı anahtarla ilk yanıtı yeniden verir. */
  respond(request: StripeRequest, query: URLSearchParams): { status: number; body: Obj; replayed: boolean } {
    const key = request.headers['idempotency-key'];
    if (typeof key === 'string' && request.method === 'POST') {
      const previous = this.idempotent.get(key);
      if (previous) return { ...previous, replayed: true };
      const result = this.handle(request.method, request.path, query, request.body);
      this.idempotent.set(key, result);
      return { ...result, replayed: false };
    }
    return { ...this.handle(request.method, request.path, query, request.body), replayed: false };
  }
}

export interface StripeServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startStripe(fixture: StripeFixture): Promise<StripeServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stripe.fixture');
      const request: StripeRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        body: parseForm(Buffer.concat(chunks).toString()),
        headers: req.headers,
      };
      fixture.requests.push(request);
      if (fixture.failWith !== null) {
        res.writeHead(fixture.failWith, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: 'fixture unavailable' } }));
        return;
      }
      const { status, body, replayed } = fixture.respond(request, url.searchParams);
      res.writeHead(status, {
        'content-type': 'application/json',
        'request-id': 'req_fixture',
        ...(replayed ? { 'idempotent-replayed': 'true' } : {}),
      });
      res.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
