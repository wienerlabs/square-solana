// `createHostedAgent`: yapılandırmadan kurum agent'ı. Yapı taşları yeniden yazılmaz:
// - agent kartı, A2A uç noktası, job kabulü ve teslimi `@squaresdk/solana-agent-sdk`'nın `createAgent`'ı;
// - capability başına MCP havuzu `@squaresdk/solana-mcp/client`'ın `McpClientPool`'u;
// - politika kuralları, ispat izleyicisi `@squaresdk/solana-policy`; tx'ler `@squaresdk/solana-sdk`.
// Gelen iş capability'sinin çalıştırma bağlamına (runtime.ts) gider; çıktı agent-sdk üzerinden teslim edilir.
import type { Server } from 'node:http';
import { createApiKeyAuthenticator, type TaskStore } from '@squaresdk/solana-a2a';
import { createAgent, type Agent, type AgentLogger, type JobRequest } from '@squaresdk/solana-agent-sdk';
import { McpClientPool, type McpServerTarget } from '@squaresdk/solana-mcp/client';
import type { Prover, PolicySalts } from '@squaresdk/solana-policy';
import { PublicKey, type Connection, type Keypair } from '@solana/web3.js';
import { createApiClient, createSquareClient, type SquareApi } from '@squaresdk/solana-sdk';
import type { PolicyDocument } from '@squaresdk/solana-types';
import type { MessagesClient, ToolCallRecord } from './claude.js';
import { envRequired, envValue, type EnvValue, type HostedConfig, type McpServerConfig } from './config.js';
import { delegateTool } from './delegate-tool.js';
import { createDelegator, type Delegator, type UnsignedDelegationTx } from './delegation.js';
import { createDuties, type DutyAction, type Duties } from './duties.js';
import { createMemoryLedger, type DelegationLedger } from './ledger.js';
import { CapabilityRuntime, type RuntimeStats } from './runtime.js';
import type { InstitutionSigner } from './signer.js';
import { createApiTravelRuleStore, type TravelRuleStore } from './travel-rule.js';

export interface HostedDeps {
  connection: Connection;
  /** A2A görev deposu (ürün: `@squaresdk/solana-a2a/prisma`). */
  store: TaskStore;
  /** Claude istemcisi (ürün: `new Anthropic()`, anahtar ortamdan); testlerde sahte. */
  anthropic: MessagesClient;
  /** Job'ların agent cüzdanı. */
  agentSigner: Keypair;
  /** Kurumun imzacısı; delegasyon ve duty'ler açıksa zorunlu. */
  institutionSigner?: InstitutionSigner;
  /** Square API'si; verilmezse yapılandırmadan (`api.baseUrl`, anahtar `api.apiKeyEnv`). */
  api?: SquareApi;
  /** Delegasyon ve ispat bağlama için kurumun politikası (`loadHostedConfig`). */
  policy?: PolicyDocument | null;
  /**
   * Travel Rule deposu; verilmezse yerel keypair'li kurumda Square API'si (`createApiTravelRuleStore`), imzasız
   * kipte yok (eşik üstü delegasyon reddedilir).
   */
  travelRule?: TravelRuleStore | null;
  /** Delegasyon defteri; verilmezse bellekte. */
  ledger?: DelegationLedger;
  /** İspat bağlama: salt'lar ve prover. */
  proofs?: { salts: PolicySalts; prover: Prover } | null;
  /** MCP sunucu hedefleri; verilmezse yapılandırmadan (`mcpTargetsFromConfig`). */
  mcpTargets?: Record<string, McpServerTarget>;
  /** Ortam (API ve A2A anahtarları, MCP sunucularının `fromEnv` değerleri); verilmezse `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** A2A delegasyon gönderimi için fetch. */
  a2aFetch?: typeof fetch;
  /** Duty'lerin ispat izleyicisi (testler). */
  watch?: Parameters<typeof createDuties>[0]['watch'];
  /** Unix saniyesi. */
  now?: () => number;
  logger?: AgentLogger;
  onError?: (error: unknown) => void;
  onToolCall?: (capability: string, call: ToolCallRecord) => void;
  onUnsignedTx?: (tx: UnsignedDelegationTx) => void | Promise<void>;
  onDutyAction?: (action: DutyAction) => void;
}

export interface HostedAgent {
  readonly agent: Agent;
  readonly config: HostedConfig;
  /** Delegasyon kapalıysa null. */
  readonly delegator: Delegator | null;
  /** Duty'ler kapalıysa null. */
  readonly duties: Duties | null;
  /** `start` sonrası dinleyen sunucu; başlamadıysa null. */
  readonly server: Server | null;
  runtime(capability: string): CapabilityRuntime;
  stats(): Record<string, RuntimeStats>;
  /** Yapılandırmaya göre kayıt (`agent.register`), dinleme ve duty'leri başlatır. */
  start(): Promise<Server>;
  close(): Promise<void>;
}

/** Yapılandırmadaki MCP sunucuları → havuz hedefleri; `fromEnv` değerleri ortamdan çözülür. */
export function mcpTargetsFromConfig(
  servers: Record<string, McpServerConfig>,
  env: NodeJS.ProcessEnv,
): Record<string, McpServerTarget> {
  const resolve = (values: Record<string, EnvValue>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, envValue(value, env)]));
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]): [string, McpServerTarget] => [
      name,
      server.type === 'stdio'
        ? {
            type: 'stdio',
            command: server.command,
            ...(server.args && { args: server.args }),
            ...(server.env && { env: resolve(server.env) }),
            ...(server.cwd && { cwd: server.cwd }),
          }
        : { type: 'http', url: server.url, ...(server.headers && { headers: resolve(server.headers) }) },
    ]),
  );
}

export async function createHostedAgent(config: HostedConfig, deps: HostedDeps): Promise<HostedAgent> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const onError = deps.onError ?? ((error: unknown) => deps.logger?.error(String(error)));
  const programIds = {
    registry: new PublicKey(config.chain.programIds.registry),
    policy: new PublicKey(config.chain.programIds.policy),
    verifier: new PublicKey(config.chain.programIds.verifier),
    escrow: new PublicKey(config.chain.programIds.escrow),
  };
  const computeUnitPrice = config.chain.computeUnitPrice ? BigInt(config.chain.computeUnitPrice) : undefined;
  const client = createSquareClient({ connection: deps.connection, programIds, commitment: config.chain.commitment });
  const api =
    deps.api ??
    createApiClient({ baseUrl: config.api.baseUrl, auth: { apiKey: envRequired(config.api.apiKeyEnv, env) } });
  const ledger = deps.ledger ?? createMemoryLedger();

  const institutionSigner = deps.institutionSigner ?? null;
  if ((config.delegation || config.duties) && !institutionSigner) {
    throw new Error("createHostedAgent: delegasyon ve duty'ler kurumun imzacısını ister");
  }
  if (institutionSigner && config.signers.institution?.type !== institutionSigner.type) {
    throw new Error('createHostedAgent: kurum imzacısının türü yapılandırmayla aynı olmalı');
  }

  let delegator: Delegator | null = null;
  if (config.delegation) {
    if (!deps.policy) throw new Error('createHostedAgent: delegasyon kurumun politika belgesini ister');
    delegator = createDelegator({
      client,
      connection: deps.connection,
      commitment: config.chain.commitment,
      config: config.delegation,
      policy: deps.policy,
      signer: institutionSigner!,
      ledger,
      env,
      now,
      ...(computeUnitPrice !== undefined && { computeUnitPrice }),
      ...(deps.a2aFetch && { a2aFetch: deps.a2aFetch }),
      ...(deps.onUnsignedTx && { onUnsignedTx: deps.onUnsignedTx }),
      travelRule:
        deps.travelRule !== undefined
          ? deps.travelRule
          : institutionSigner!.type === 'keypair' && config.delegation.travelRule
            ? createApiTravelRuleStore({ baseUrl: config.api.baseUrl, keypair: institutionSigner!.keypair, now })
            : null,
    });
  }

  let duties: Duties | null = null;
  if (config.duties) {
    if (institutionSigner?.type !== 'keypair') throw new Error("createHostedAgent: duty'ler yerel keypair ister");
    if (config.duties.policyWatch && (!deps.proofs || !deps.policy)) {
      throw new Error('createHostedAgent: ispat bağlama politika, salt ve prover ister');
    }
    duties = createDuties({
      client,
      connection: deps.connection,
      commitment: config.chain.commitment,
      config: config.duties,
      signer: institutionSigner.keypair,
      ledger,
      api,
      proofs: config.duties.policyWatch ? { policy: deps.policy!, ...deps.proofs! } : null,
      now,
      onError,
      ...(computeUnitPrice !== undefined && { computeUnitPrice }),
      ...(deps.watch && { watch: deps.watch }),
      ...(deps.onDutyAction && { onAction: deps.onDutyAction }),
    });
  }

  // Capability başına ayrı havuz: yalnızca capability'nin sunucuları.
  const targets = deps.mcpTargets ?? mcpTargetsFromConfig(config.mcp?.servers ?? {}, env);
  const runtimes = new Map<string, CapabilityRuntime>();
  for (const capability of config.capabilities) {
    let pool: McpClientPool | null = null;
    if (capability.tools.length > 0) {
      const mcp = config.mcp!;
      const servers = Object.fromEntries(
        capability.tools.map((grant) => {
          const target = targets[grant.server];
          if (!target) throw new Error(`createHostedAgent: ${grant.server} MCP sunucusunun hedefi yok`);
          return [grant.server, target];
        }),
      );
      pool = new McpClientPool({
        servers,
        maxConcurrency: mcp.maxConcurrency,
        toolCacheTtlMs: mcp.toolCacheTtlMs,
        requestTimeoutMs: mcp.requestTimeoutMs,
        reconnect: mcp.reconnect,
        clientInfo: { name: `square-hosted/${config.agent.agentId}/${capability.id}`, version: config.agent.version },
      });
    }
    runtimes.set(
      capability.id,
      new CapabilityRuntime({
        capability,
        pool,
        client: deps.anthropic,
        ...(capability.delegation && delegator && { extraTools: [delegateTool(delegator)] }),
        ...(deps.onToolCall && { onToolCall: deps.onToolCall }),
      }),
    );
  }
  const runtime = (id: string) => {
    const found = runtimes.get(id);
    if (!found) throw new Error(`bilinmeyen capability: ${id}`);
    return found;
  };

  let agent: Agent;
  try {
    agent = await createAgent({
      name: config.agent.name,
      description: config.agent.description,
      version: config.agent.version,
      ...(config.agent.provider && { provider: config.agent.provider }),
      publicUrl: config.agent.publicUrl,
      agentId: config.agent.agentId,
      capabilities: config.capabilities.map((capability) => ({
        id: capability.id,
        name: capability.name,
        description: capability.description,
        tags: capability.tags,
        ...(capability.examples && { examples: capability.examples }),
        price: BigInt(capability.price),
      })),
      handler: (request: JobRequest) => runtime(request.capability.id).run(request),
      signer: deps.agentSigner,
      connection: deps.connection,
      programIds,
      commitment: config.chain.commitment,
      api,
      store: deps.store,
      authenticate: createApiKeyAuthenticator({ keys: config.agent.callers }),
      ...(config.agent.autoListClaim && { autoListClaim: config.agent.autoListClaim }),
      ...(computeUnitPrice !== undefined && { tx: { computeUnitPrice } }),
      onError,
      ...(deps.logger && { logger: deps.logger }),
      now,
    });
  } catch (error) {
    await Promise.allSettled([...runtimes.values()].map((item) => item.close()));
    throw error;
  }

  let server: Server | null = null;
  return {
    agent,
    config,
    delegator,
    duties,
    get server() {
      return server;
    },
    runtime,
    stats: () => Object.fromEntries([...runtimes].map(([id, item]) => [id, item.stats()])),
    async start() {
      if (config.agent.register !== 'none') await agent.register({ hosting: config.agent.register });
      server = await agent.listen(config.agent.listen);
      duties?.start();
      return server;
    },
    async close() {
      duties?.stop();
      await agent.close();
      server = null;
      await Promise.allSettled([...runtimes.values()].map((item) => item.close()));
    },
  };
}
