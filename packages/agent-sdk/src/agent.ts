// `createAgent`: agent card'ı (well-known yolunda), A2A v1.0 uç noktasını (`@squaresdk/solana-a2a`) ve job
// akışını (job.ts) tek bir `node:http` işleyicisinde birleştirir. Kaynak: aip-beta `packages/agent-sdk`
// @ 5a36fe0 (MIT, LICENSE-MIT); Express sunucusu, standart dışı `task/create` / `task/status` yöntemleri ve
// did:aip v1 kimliği yerine A2A v1.0, zincirdeki Square job'u ve did:aip v2 Solana profili (BE-19).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createA2aServer, createChainJobSource, type A2aServer, type A2aServerLimits } from '@squaresdk/solana-a2a';
import { squareIdentity } from '@squaresdk/solana-identity';
import { createApiClient, createSquareClient, type SquareApi } from '@squaresdk/solana-sdk';
import { A2A_PATH, WELL_KNOWN_AGENT_CARD_PATH, agentUrls, assertAgentId, buildAgentCard, encodeCard } from './card.js';
import { createTxSender, toWallet } from './chain.js';
import { apiDeliveryUploader } from './delivery.js';
import { assertDiscountBps, createJobExecutor } from './job.js';
import { registerAgent } from './register.js';
import type { Agent, AgentOptions } from './types.js';

/**
 * A2A sunucusunun varsayılan sınırları; `limits` ile değiştirilir. Akışsız `SendMessage` en fazla
 * `blockingTimeoutMs` bekler (docs/design/a2a.md §10.4): uzun işlerde istemci akışa abone olur.
 */
export const DEFAULT_A2A_LIMITS: Readonly<A2aServerLimits> = Object.freeze({
  maxBodyBytes: 256 * 1024,
  maxStreams: 256,
  maxStreamsPerCaller: 16,
  heartbeatMs: 15_000,
  streamMaxDurationMs: 30 * 60_000,
  blockingTimeoutMs: 60_000,
  maxHistory: 100,
  maxMessagesPerTask: 50,
  maxArtifactBytes: 1024 * 1024,
});

const isSquareApi = (api: NonNullable<AgentOptions['api']>): api is SquareApi =>
  typeof (api as SquareApi).uploadDelivery === 'function';

/** CAIP-2 Solana referansı: genesis hash'in ilk 32 karakteri (did:aip Solana profili §3.3). */
async function chainRefOf(options: AgentOptions): Promise<string> {
  if (options.chainRef !== undefined) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32}$/.test(options.chainRef)) {
      throw new Error(`createAgent: chainRef 32 karakter base58 olmalı: ${options.chainRef}`);
    }
    return options.chainRef;
  }
  return (await options.connection.getGenesisHash()).slice(0, 32);
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

export async function createAgent(options: AgentOptions): Promise<Agent> {
  assertAgentId(options.agentId);
  const urls = agentUrls(options.publicUrl);
  if (options.autoListClaim) assertDiscountBps(options.autoListClaim.discountBps);
  const commitment = options.commitment ?? options.connection.commitment;
  if (!commitment) throw new Error('createAgent: commitment gerekli (options.commitment ya da bağlantının)');

  const api = options.api ? (isSquareApi(options.api) ? options.api : createApiClient(apiConfig(options.api))) : null;
  const delivery = options.delivery ?? (api ? apiDeliveryUploader(api) : null);
  if (!delivery) throw new Error('createAgent: teslimat için api ya da delivery verilmeli');

  const wallet = toWallet(options.signer);
  const owner = options.owner ?? wallet.publicKey;
  const client = createSquareClient({
    connection: options.connection,
    programIds: options.programIds,
    commitment,
  });
  const [agentRecord] = client.pda.agentRecord(owner, options.agentId);
  const config = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
  if (!config) throw new Error('createAgent: escrow config zincirde yok (programIds ve bağlantıyı denetleyin)');
  const chainRef = await chainRefOf(options);
  const did = squareIdentity.formatDidAip({ chainRef, registry: options.programIds.registry, agentRecord });
  const card = buildAgentCard({
    name: options.name,
    description: options.description,
    version: options.version,
    ...(options.provider ? { provider: options.provider } : {}),
    urls,
    did,
    capabilities: options.capabilities,
    chainRef,
    registry: options.programIds.registry,
    agentRecord,
    settlementMint: config.settlementMint,
  });
  const { bytes: cardBytes, hash: cardHash } = encodeCard(card);

  const report = (error: unknown) => {
    try {
      options.onError?.(error);
      options.logger?.error(error instanceof Error ? error.message : String(error));
    } catch {
      return;
    }
  };
  const sender = createTxSender({ connection: options.connection, commitment, client });
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tx = options.tx ?? {};
  const a2a: A2aServer = createA2aServer({
    agentRecord: agentRecord.toBase58(),
    store: options.store,
    jobSource: createChainJobSource(client),
    authenticate: options.authenticate,
    executor: createJobExecutor({
      client,
      sender,
      wallet,
      capabilities: options.capabilities,
      handler: options.handler,
      delivery,
      ...(options.autoListClaim ? { autoListClaim: options.autoListClaim } : {}),
      ...(options.onClaimListed ? { onClaimListed: options.onClaimListed } : {}),
      tx,
      now,
      ...(options.logger ? { logger: options.logger } : {}),
      onError: report,
    }),
    limits: { ...DEFAULT_A2A_LIMITS, ...options.limits },
    onError: report,
  });

  const cardPath = `${urls.basePath}${WELL_KNOWN_AGENT_CARD_PATH}`;
  const a2aPath = `${urls.basePath}${A2A_PATH}`;
  const cardBody = Buffer.from(cardBytes);
  const etag = `"${cardHash}"`;
  let server: Server | null = null;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://agent.invalid').pathname;
    if (path === a2aPath) return a2a.handle(request, response);
    if (path !== cardPath) return sendJson(response, 404, { error: 'bulunamadı' });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { error: 'yalnızca GET' }, { allow: 'GET, HEAD' });
    }
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag });
      response.end();
      return;
    }
    // Baytlar `agent_card_hash`'in hesaplandığı baytlardır; yeniden serileştirilmez.
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': cardBody.length,
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
      etag,
    });
    response.end(request.method === 'HEAD' ? undefined : cardBody);
  }

  return {
    card,
    cardBytes,
    cardHash,
    cardUrl: urls.card,
    a2aUrl: urls.a2a,
    did,
    agentRecord,
    handle,
    resume: () => a2a.resume(),
    async listen({ port, host }) {
      if (server) throw new Error('agent zaten dinliyor');
      const resumed = await a2a.resume();
      const created = createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
          report(error);
          if (!response.headersSent) sendJson(response, 500, { error: 'iç hata' });
          else response.destroy();
        });
      });
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject);
        created.listen(port, host, () => {
          created.off('error', reject);
          resolve();
        });
      });
      server = created;
      options.logger?.info(
        `${options.name} dinliyor: ${urls.card} (${did}); ${resumed} görev sürdürüldü; ` +
          `capability: ${options.capabilities.map((c) => c.id).join(', ')}`,
      );
      return created;
    },
    async close() {
      await a2a.close();
      const current = server;
      server = null;
      if (!current) return;
      current.closeAllConnections();
      await new Promise<void>((resolve) => current.close(() => resolve()));
    },
    register: (registerOptions) =>
      registerAgent(
        {
          client,
          sender,
          wallet,
          owner,
          agentId: options.agentId,
          agentRecord,
          card,
          cardHash,
          cardUrl: urls.card,
          api,
          tx,
        },
        registerOptions,
      ),
  };
}

function apiConfig(api: { baseUrl: string; apiKey?: string; fetch?: typeof fetch }) {
  return {
    baseUrl: api.baseUrl,
    ...(api.apiKey ? { auth: { apiKey: api.apiKey } } : {}),
    ...(api.fetch ? { fetch: api.fetch } : {}),
  };
}
