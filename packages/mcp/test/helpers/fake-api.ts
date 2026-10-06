// Test fixture: Square REST API'sinin MCP'nin kullandığı uçlarını bellekteki görünümlerle yanıtlayan sahte
// sunucu. Zarf, sayfalama ve hata biçimi docs/api/openapi.yaml'daki gibidir. Aynı nesne hem `fetch` olarak
// (bellek içi testler) hem yerel HTTP sunucusu olarak (stdio ve HTTP uçtan uca testleri) kullanılır.
// `POST /v1/tx` gerçek API gibi istekteki imzacılarla imzasız bir v0 tx döner (escrow programını çağıran).
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PublicKey } from '@solana/web3.js';
import type {
  AgentView,
  ApiError,
  DisputeView,
  IndexedEvent,
  JobView,
  KeeperAction,
  PolicyView,
  ScreeningView,
  TxRequest,
  UnsignedTx,
} from '@squaresdk/solana-types';
import { BLOCKHASH, ESCROW_PROGRAM, toBase64, unsignedTx } from './fixtures.js';

type Handler = (request: TxRequest) => UnsignedTx | { status: number; error: Partial<ApiError> };

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  apiKey: string | null;
}

export class FakeApi {
  readonly jobs = new Map<string, JobView>();
  readonly agents = new Map<string, AgentView>();
  readonly disputes = new Map<string, DisputeView>();
  readonly screenings = new Map<string, ScreeningView>();
  readonly policies = new Map<string, PolicyView>();
  readonly events: IndexedEvent[] = [];
  readonly keeper: KeeperAction[] = [];
  /** Durum → listJobs toplamı (verilmezse bellekteki job'lar sayılır). */
  readonly totals = new Map<string, number>();
  readonly requests: ApiRequest[] = [];
  readonly txRequests: TxRequest[] = [];
  readonly uploads: { job: string; type: string; text: string }[] = [];
  /** Sonraki isteğe verilecek hata. */
  failNext: { status: number; error: Partial<ApiError> } | null = null;
  prepare: Handler = (request) => {
    const signers = new Set<string>([request.feePayer]);
    for (const name of ['institution', 'agent', 'payer']) {
      const value = request.accounts[name];
      if (value) signers.add(value);
    }
    const tx = unsignedTx({
      feePayer: new PublicKey(request.feePayer),
      signers: [...signers].map((key) => new PublicKey(key)),
      programId: this.escrowProgram,
    });
    return {
      transaction: toBase64(tx),
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 5150,
      feePayer: request.feePayer,
      signers: [...signers],
      addressLookupTables: [],
      computeUnitLimit: 100_000,
      simulatedUnits: 41_000,
    };
  };

  constructor(readonly escrowProgram: PublicKey = ESCROW_PROGRAM) {}

  readonly fetch: typeof fetch = async (input, init) => this.handle(new Request(input, init));

  private envelope(status: number, data: unknown, page?: { page: number; limit: number; total: number }) {
    return Response.json(
      {
        success: true,
        data,
        error: null,
        meta: { requestId: 'req-1', page: page?.page ?? null, limit: page?.limit ?? null, total: page?.total ?? null },
      },
      { status },
    );
  }

  private error(status: number, error: Partial<ApiError>) {
    return Response.json(
      {
        success: false,
        data: null,
        error: { code: 'internal_error', message: 'hata', programError: null, details: null, ...error },
        meta: { requestId: 'req-1', page: null, limit: null, total: null },
      },
      { status },
    );
  }

  private notFound() {
    return this.error(404, { code: 'not_found', message: 'kaynak bulunamadı' });
  }

  private page<T>(items: T[], query: Record<string, string>, total?: number) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 50);
    return this.envelope(200, items.slice((page - 1) * limit, page * limit), {
      page,
      limit,
      total: total ?? items.length,
    });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams);
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query,
      apiKey: request.headers.get('x-api-key'),
    });
    if (this.failNext) {
      const { status, error } = this.failNext;
      this.failNext = null;
      return this.error(status, error);
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const route =
      url.pathname === '/v1/keeper/actions'
        ? `${request.method} ${url.pathname}`
        : `${request.method} /${parts.map((part, i) => (i === 2 ? ':id' : part)).join('/')}`;
    const id = parts[2] ?? '';

    switch (route) {
      case 'GET /v1/jobs': {
        let jobs = [...this.jobs.values()];
        if (query.status) jobs = jobs.filter((job) => job.account.status === query.status);
        if (query.agentRecord) jobs = jobs.filter((job) => job.account.agentRecord === query.agentRecord);
        if (query.institution) jobs = jobs.filter((job) => job.account.institution === query.institution);
        if (query.policy) jobs = jobs.filter((job) => job.account.policy === query.policy);
        return this.page(jobs, query, query.status ? this.totals.get(query.status) : undefined);
      }
      case 'GET /v1/jobs/:id':
        return this.jobs.has(id) ? this.envelope(200, this.jobs.get(id)) : this.notFound();
      case 'POST /v1/jobs/:id/deliveries': {
        if (!this.jobs.has(id)) return this.notFound();
        const file = (await request.formData()).get('file') as Blob;
        const text = await file.text();
        this.uploads.push({ job: id, type: file.type, text });
        const workHash = createHash('sha256').update(text).digest('hex');
        return this.envelope(201, {
          workHash,
          deliveryUri: `https://deliveries.example/${workHash}`,
          contentType: file.type,
          size: Buffer.byteLength(text),
        });
      }
      case 'GET /v1/events': {
        const events = this.events.filter(
          (event) => !query.job || JSON.stringify(event.payload.data).includes(query.job),
        );
        return this.page(events, query);
      }
      case 'GET /v1/disputes':
        return this.page([...this.disputes.values()], query);
      case 'GET /v1/disputes/:id':
        return this.disputes.has(id) ? this.envelope(200, this.disputes.get(id)) : this.notFound();
      case 'GET /v1/keeper/actions':
        return this.page(
          this.keeper.filter((action) => !query.outcome || action.outcome === query.outcome),
          query,
        );
      case 'GET /v1/agents': {
        let agents = [...this.agents.values()];
        if (query.owner) agents = agents.filter((agent) => agent.account.owner === query.owner);
        if (query.status) agents = agents.filter((agent) => agent.account.status === query.status);
        if (query.skill) {
          agents = agents.filter((agent) =>
            agent.card?.skills.some((skill) => skill.id === query.skill || skill.tags.includes(query.skill!)),
          );
        }
        return this.page(agents, query);
      }
      case 'GET /v1/agents/:id':
        return this.agents.has(id) ? this.envelope(200, this.agents.get(id)) : this.notFound();
      case 'GET /v1/screening/:id':
        return this.screenings.has(id) ? this.envelope(200, this.screenings.get(id)) : this.notFound();
      case 'GET /v1/policies/:id':
        return this.policies.has(id) ? this.envelope(200, this.policies.get(id)) : this.notFound();
      case 'POST /v1/tx': {
        const body = (await request.json()) as TxRequest;
        this.txRequests.push(body);
        const result = this.prepare(body);
        if ('error' in result) return this.error(result.status, result.error);
        return this.envelope(200, result);
      }
      default:
        return this.notFound();
    }
  }

  /** Yerel HTTP sunucusu olarak dinler. */
  async listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value);
        }
        const request = new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method!,
          headers,
          ...(body && req.method !== 'GET' ? { body } : {}),
        });
        this.handle(request)
          .then(async (response) => {
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(Buffer.from(await response.arrayBuffer()));
          })
          .catch((error: unknown) => {
            res.writeHead(500);
            res.end(String(error));
          });
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }
}
