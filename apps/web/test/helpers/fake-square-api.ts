// Portal ve fiat testleri için bellek içi Square API (FE-22, FE-20): yalnızca bu testlerin çağırdığı uçlar,
// sözleşmedeki yol, zarf ve kodlarla. SDK'nın `createApiClient`'ine `fetch` olarak verilir; imza Ed25519 ile gerçekten doğrulanır.
// API'nin kendisi apps/api testlerindedir.
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import type {
  ApiKey,
  ApiKeyScope,
  FiatAttestation,
  FiatConfig,
  FiatCustomer,
  X402Endpoint,
  X402EndpointCreate,
  X402EndpointUpdate,
  X402Payment,
} from '@squaresdk/solana-types';
import bs58 from 'bs58';

export interface TestWallet {
  readonly address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** Ed25519 cüzdanı: adres açık anahtarın base58'i. */
export function testWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return {
    address: bs58.encode(raw),
    signMessage: async (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}

const publicKeyOf = (address: string): KeyObject =>
  createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(bs58.decode(address)).toString('base64url') },
    format: 'jwk',
  });

const NOW = 1_791_300_000;
const clockSeconds = () => Math.floor(Date.now() / 1000);
const meta = { requestId: 'test', page: null, limit: null, total: null };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown, status = 200) => json(status, { success: true, data, error: null, meta });
const fail = (status: number, code: string, message: string) =>
  json(status, { success: false, data: null, error: { code, message, programError: null, details: null }, meta });

export interface FakeSquareApi {
  readonly fetch: typeof globalThis.fetch;
  readonly keys: (ApiKey & { secret: string })[];
  readonly endpoints: X402Endpoint[];
  readonly payments: X402Payment[];
  /** Sonraki isteklerde oturum geçersiz sayılır. */
  expireSessions(): void;
  /** Fiat rayı: yapılandırma (yoksa 503), işe göre attestation ve kuruma göre kayıtlı kart. */
  readonly fiat: {
    config: FiatConfig | null;
    readonly attestations: Map<string, FiatAttestation>;
    readonly customers: Map<string, FiatCustomer>;
  };
}

export function fakeSquareApi(domain = globalThis.location?.host ?? 'app.square.test'): FakeSquareApi {
  const challenges = new Map<string, { wallet: string; message: string }>();
  const sessions = new Map<string, string>();
  const keys: (ApiKey & { secret: string })[] = [];
  const endpoints: X402Endpoint[] = [];
  const payments: X402Payment[] = [];
  const fiat: FakeSquareApi['fiat'] = { config: null, attestations: new Map(), customers: new Map() };

  const handle = async (method: string, path: string, headers: Headers, body: unknown): Promise<Response> => {
    if (method === 'GET' && path === '/v1/fiat/config') {
      return fiat.config ? ok(fiat.config) : fail(503, 'payment_unavailable', 'fiat rayı yapılandırılmamış');
    }
    if (method === 'POST' && path === '/v1/auth/challenge') {
      const { wallet } = body as { wallet: string };
      const nonce = randomUUID().replaceAll('-', '');
      const message = `${domain} wants you to sign in with your Solana account:\n${wallet}\n\nSign in to Square.\n\nNonce: ${nonce}`;
      challenges.set(nonce, { wallet, message });
      return ok({ nonce, message, expiresAt: clockSeconds() + 300 });
    }
    if (method === 'POST' && path === '/v1/auth/session') {
      const { wallet, nonce, signature } = body as { wallet: string; nonce: string; signature: string };
      const challenge = challenges.get(nonce);
      challenges.delete(nonce);
      if (
        !challenge ||
        challenge.wallet !== wallet ||
        !verify(null, Buffer.from(challenge.message), publicKeyOf(wallet), bs58.decode(signature))
      ) {
        return fail(401, 'unauthorized', 'imza geçersiz');
      }
      const token = `sqs_${randomUUID()}`;
      sessions.set(token, wallet);
      return ok({ token, wallet, expiresAt: clockSeconds() + 3_600 });
    }
    const token = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1] ?? '';
    if (!sessions.has(token)) return fail(401, 'unauthorized', 'oturum gerekli');
    if (method === 'DELETE' && path === '/v1/auth/session') {
      sessions.delete(token);
      return new Response(null, { status: 204 });
    }

    const attestationMatch = /^\/v1\/jobs\/([^/]+)\/fiat\/attestation$/.exec(path);
    if (attestationMatch && method === 'GET') {
      const found = fiat.attestations.get(attestationMatch[1]!);
      return found ? ok(found) : fail(404, 'not_found', 'işin ödemesi yok');
    }
    const customerMatch = /^\/v1\/fiat\/customers\/([^/]+)$/.exec(path);
    if (customerMatch && method === 'GET') {
      const found = fiat.customers.get(customerMatch[1]!);
      return found ? ok(found) : fail(404, 'not_found', 'kurumun Stripe müşterisi yok');
    }

    if (path === '/v1/api-keys' && method === 'GET') return ok(keys.map(({ secret: _secret, ...key }) => key));
    if (path === '/v1/api-keys' && method === 'POST') {
      const { label, scopes } = body as { label: string; scopes: ApiKeyScope[] };
      const secret = `sqk_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
      const key = { id: randomUUID(), label, prefix: secret.slice(0, 12), scopes, createdAt: NOW, lastUsedAt: null };
      keys.unshift({ ...key, secret });
      return ok({ apiKey: key, secret }, 201);
    }
    const keyMatch = /^\/v1\/api-keys\/([^/]+)$/.exec(path);
    if (keyMatch && method === 'DELETE') {
      const index = keys.findIndex((key) => key.id === keyMatch[1]);
      if (index < 0) return fail(404, 'not_found', 'API anahtarı bulunamadı');
      keys.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    if (path === '/v1/x402/endpoints' && method === 'GET') return ok(endpoints);
    if (path === '/v1/x402/endpoints' && method === 'POST') {
      const create = body as X402EndpointCreate;
      if (endpoints.some((endpoint) => endpoint.path === create.path)) {
        return fail(409, 'conflict', 'bu yolda başka bir ücretli uç nokta var');
      }
      const endpoint = { ...create, id: randomUUID(), createdAt: NOW, updatedAt: NOW };
      endpoints.unshift(endpoint);
      return ok(endpoint, 201);
    }
    const endpointMatch = /^\/v1\/x402\/endpoints\/([^/]+)(\/usage)?$/.exec(path);
    if (endpointMatch) {
      const index = endpoints.findIndex((endpoint) => endpoint.id === endpointMatch[1]);
      if (index < 0) return fail(404, 'not_found', 'ücretli uç nokta bulunamadı');
      const endpoint = endpoints[index]!;
      if (endpointMatch[2] && method === 'GET') {
        const own = payments.filter((payment) => payment.endpointId === endpoint.id);
        const total = own.reduce((sum, payment) => sum + BigInt(payment.amount), 0n);
        return ok({
          endpointId: endpoint.id,
          payments: own.length,
          totals: own.length
            ? [{ network: endpoint.network, asset: endpoint.mint, amount: total.toString(), payments: own.length }]
            : [],
          lastPaidAt: own.length ? Math.max(...own.map((payment) => payment.settledAt)) : null,
          recent: [...own].reverse(),
        });
      }
      if (method === 'PATCH') {
        const update = body as X402EndpointUpdate;
        endpoints[index] = { ...endpoint, ...update, updatedAt: NOW + 1 };
        return ok(endpoints[index]);
      }
      if (method === 'DELETE') {
        endpoints.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }
    return fail(404, 'not_found', 'yol bulunamadı');
  };

  return {
    keys,
    endpoints,
    payments,
    fiat,
    expireSessions: () => sessions.clear(),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      return handle(request.method, url.pathname, request.headers, text ? JSON.parse(text) : null);
    },
  };
}
