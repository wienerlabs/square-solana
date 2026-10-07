import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Connection, PublicKey, type Keypair } from '@solana/web3.js';
import { isEntryPoint, reportFailure, stderr, writeText } from '@squaresdk/solana-smoke/cli';
import type { ClusterConfig, KeyRole } from '@squaresdk/solana-smoke/config';
import { createContext, type Context } from '@squaresdk/solana-smoke/context';
import { loadKeypair, roleKey, type RoleKeys } from '@squaresdk/solana-smoke/keys';
import { loadCircuitArtifacts, localProver, releaseProverWorkers } from '@squaresdk/solana-smoke/prover';
import { newRunId } from '@squaresdk/solana-smoke/smoke';
import { callerGrants, createDemoAgent, serveDemoAgent, type RunningAgent } from './agent.js';
import { assertSupportedCluster } from './cluster.js';
import {
  loadAgentConfig,
  loadDemoConfig,
  requireDemo,
  selectScenarios,
  type AgentConfig,
  type DemoConfig,
  type ScenarioValues,
} from './demo-config.js';
import { assertAgentBaseUrl, runScenario, type AgentEndpoint, type ScenarioOutcome } from './scenario.js';
import { runSeed } from './seed.js';

export const A2A_KEY_ENV = 'SQUARE_DEMO_A2A_KEY';
export const CONFIG_ENV = 'SQUARE_DEMO_CONFIG';
export const SEED_ROLES: readonly KeyRole[] = ['payer', 'institution', 'agent', 'buyer', 'keeper'];
export const SCENARIO_ROLES: readonly KeyRole[] = ['payer', 'institution', 'buyer', 'keeper'];

export const USAGE = [
  'kullanım:',
  '  seed     --config <küme.json> [--rotate-policy-secret]',
  '  scenario --config <küme.json> [--scenario <ad>]... [--agent-url <https://… ya da yerel http>] [--out <sonuç.json>]',
  '  agent    --config <agent.json> [--port 8787] [--host 127.0.0.1] [--institution <adres>]... [--list-claims]',
  `yapılandırma --config ya da ${CONFIG_ENV}; A2A anahtarı ${A2A_KEY_ENV} (agent ve --agent-url için)`,
].join('\n');

export interface CliArgs {
  command: 'seed' | 'scenario' | 'agent';
  config: string;
  scenarios: string[];
  agentUrl: string | null;
  port: number;
  host: string;
  institutions: string[];
  out: string | null;
  rotatePolicySecret: boolean;
  listClaims: boolean;
}

export function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv = {}): CliArgs {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      scenario: { type: 'string', multiple: true },
      'agent-url': { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      institution: { type: 'string', multiple: true },
      out: { type: 'string' },
      'rotate-policy-secret': { type: 'boolean' },
      'list-claims': { type: 'boolean' },
    },
  });
  const [command, ...rest] = positionals;
  if ((command !== 'seed' && command !== 'scenario' && command !== 'agent') || rest.length > 0) {
    throw new Error(USAGE);
  }
  const config = values.config ?? env[CONFIG_ENV];
  if (!config) throw new Error(`yapılandırma gerekli: --config ya da ${CONFIG_ENV}\n${USAGE}`);
  const onlyFor = (flag: string, allowed: readonly CliArgs['command'][], present: boolean) => {
    if (present && !allowed.includes(command))
      throw new Error(`--${flag} yalnızca ${allowed.join(', ')} içindir\n${USAGE}`);
  };
  onlyFor('scenario', ['scenario'], values.scenario !== undefined);
  onlyFor('agent-url', ['scenario'], values['agent-url'] !== undefined);
  onlyFor('out', ['scenario'], values.out !== undefined);
  onlyFor('port', ['agent'], values.port !== undefined);
  onlyFor('host', ['agent'], values.host !== undefined);
  onlyFor('institution', ['agent'], values.institution !== undefined);
  onlyFor('list-claims', ['agent'], values['list-claims'] !== undefined);
  onlyFor('rotate-policy-secret', ['seed'], values['rotate-policy-secret'] !== undefined);
  const port = Number(values.port ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port geçersiz: ${values.port}`);
  const rawAgentUrl = values['agent-url']?.replace(/\/+$/, '') ?? null;
  let agentUrl: string | null = null;
  if (rawAgentUrl !== null) {
    try {
      agentUrl = assertAgentBaseUrl(rawAgentUrl);
    } catch (error) {
      throw new Error(`--agent-url: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const institutions = (values.institution ?? []).map((value) => {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      throw new Error(`--institution base58 adres değil: ${value}`);
    }
  });
  return {
    command,
    config,
    scenarios: values.scenario ?? [],
    agentUrl,
    port,
    host: values.host ?? '127.0.0.1',
    institutions,
    out: values.out ?? null,
    rotatePolicySecret: values['rotate-policy-secret'] === true,
    listClaims: values['list-claims'] === true,
  };
}

export function requireA2aKey(env: NodeJS.ProcessEnv): string {
  const key = env[A2A_KEY_ENV]?.trim();
  if (!key) throw new Error(`${A2A_KEY_ENV} ortam değişkeni gerekli (agent ile kurumun paylaştığı A2A anahtarı)`);
  return key;
}

export function loadKeys(
  config: Pick<ClusterConfig, 'keys'>,
  required: readonly KeyRole[],
  optional: readonly KeyRole[] = [],
): RoleKeys {
  const keys: RoleKeys = {};
  for (const role of [...required, ...optional]) {
    const path = config.keys[role];
    if (path === undefined) {
      if (required.includes(role)) throw new Error(`yapılandırmada "${role}" anahtarının yolu yok`);
      continue;
    }
    keys[role] = loadKeypair(path);
  }
  return keys;
}

export interface AgentRun {
  signer: Keypair;
  institutions: string[];
  apiKey: string;
  listClaims: boolean;
}

export function prepareAgent(
  config: AgentConfig,
  args: Pick<CliArgs, 'institutions' | 'listClaims'>,
  env: NodeJS.ProcessEnv,
): AgentRun {
  const signer = loadKeypair(config.keys.agent);
  const { wallet, institutions: configured } = config.demo.agent;
  if (wallet && !wallet.equals(signer.publicKey)) {
    throw new Error(`demo.agent.wallet ${wallet.toBase58()}, agent anahtarı ${signer.publicKey.toBase58()}`);
  }
  const institutions = args.institutions.length > 0 ? args.institutions : configured.map((key) => key.toBase58());
  if (institutions.length === 0) {
    throw new Error('A2A çağıranının kurumu gerekli: --institution <adres> ya da demo.agent.institutions');
  }
  return { signer, institutions, apiKey: requireA2aKey(env), listClaims: args.listClaims };
}

export function agentWalletFor(config: DemoConfig, keys: RoleKeys): PublicKey {
  const demo = requireDemo(config);
  const signer = keys.agent;
  if (demo.agent.wallet && signer && !demo.agent.wallet.equals(signer.publicKey)) {
    throw new Error(`demo.agent.wallet ${demo.agent.wallet.toBase58()}, agent anahtarı ${signer.publicKey.toBase58()}`);
  }
  const wallet = demo.agent.wallet ?? signer?.publicKey;
  if (!wallet) throw new Error('--agent-url ile agent cüzdanı demo.agent.wallet olarak verilmeli');
  return wallet;
}

const agentLogger = {
  info: (message: string) => stderr(`agent: ${message}`),
  error: (message: string) => stderr(`agent hata: ${message}`),
};

export function txOptions(config: Pick<ClusterConfig, 'computeUnitPrice' | 'lookupTable'>) {
  const { computeUnitPrice, lookupTable } = config;
  return {
    ...(computeUnitPrice === undefined ? {} : { computeUnitPrice: BigInt(computeUnitPrice) }),
    ...(lookupTable ? { addressLookupTables: [lookupTable] } : {}),
  };
}

export async function startInProcessAgent(
  context: Context,
  config: DemoConfig,
  apiKey: string,
  options: { port: number; host: string; institutions: readonly string[]; listClaims: boolean },
): Promise<RunningAgent> {
  const demo = requireDemo(config);
  const agent = await createDemoAgent({
    settings: demo.agent,
    signer: roleKey(context.keys, 'agent'),
    connection: context.connection,
    commitment: context.config.commitment,
    programIds: context.config.programIds,
    callers: callerGrants(apiKey, options.institutions),
    listClaims: options.listClaims,
    tx: txOptions(context.config),
    logger: agentLogger,
  });
  return serveDemoAgent(agent, { port: options.port, host: options.host, onError: (error) => reportFailure(error) });
}

export type AgentProvider = (scenario: ScenarioValues) => Promise<{ endpoint: AgentEndpoint; close(): Promise<void> }>;

export function externalAgent(endpoint: AgentEndpoint): AgentProvider {
  return async () => ({ endpoint, close: async () => undefined });
}

export function inProcessAgent(context: Context, config: DemoConfig): AgentProvider {
  const institution = roleKey(context.keys, 'institution').publicKey.toBase58();
  return async (scenario) => {
    const apiKey = randomBytes(32).toString('hex');
    const running = await startInProcessAgent(context, config, apiKey, {
      port: 0,
      host: '127.0.0.1',
      institutions: [institution],
      listClaims: scenario.claimSale,
    });
    stderr(`agent (süreç içi${scenario.claimSale ? ', alacak listeler' : ''}): ${running.url}`);
    return { endpoint: { baseUrl: running.url, apiKey }, close: () => running.close() };
  };
}

export async function runScenarios(params: {
  context: Context;
  config: DemoConfig;
  names: readonly string[];
  agent: AgentProvider;
  agentWallet: PublicKey;
  runId: string;
}): Promise<ScenarioOutcome[]> {
  const demo = requireDemo(params.config);
  const prover = localProver(loadCircuitArtifacts());
  const outcomes: ScenarioOutcome[] = [];
  for (const [name, scenario] of selectScenarios(demo, params.names)) {
    const agent = await params.agent(scenario);
    try {
      outcomes.push(
        await runScenario({
          context: params.context,
          config: params.config,
          name,
          scenario,
          agent: agent.endpoint,
          agentWallet: params.agentWallet,
          prover,
          runId: params.runId,
        }),
      );
    } finally {
      await agent.close();
    }
  }
  return outcomes;
}

export function outcomeLine(outcome: ScenarioOutcome): string {
  const paid = `${outcome.settlement.recipientRole} ${outcome.settlement.net}`;
  return [
    `senaryo ${outcome.name} (${outcome.expect}): job ${outcome.job} ${outcome.settlement.status}, ${paid}`,
    `ispat ${outcome.proof.verdict}${outcome.proof.refusalCode ? ` kod ${outcome.proof.refusalCode} (${outcome.proof.rules.join(', ')})` : ''}`,
    `teslimat ${outcome.delivery.workHash.slice(0, 16)}…, rapor ${outcome.report.accounts} hesap slot ${outcome.report.slot}`,
    outcome.claim ? `alacak ${outcome.claim.price} ile alıcıya satıldı` : null,
  ]
    .filter(Boolean)
    .join('; ');
}

const waitForSignal = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });

async function runAgentCommand(args: CliArgs): Promise<void> {
  const config = loadAgentConfig(args.config);
  const run = prepareAgent(config, args, process.env);
  const connection = new Connection(config.rpcUrl, { commitment: config.commitment });
  await assertSupportedCluster(connection, config.cluster);
  const agent = await createDemoAgent({
    settings: config.demo.agent,
    signer: run.signer,
    connection,
    commitment: config.commitment,
    programIds: config.programIds,
    callers: callerGrants(run.apiKey, run.institutions),
    listClaims: run.listClaims,
    tx: txOptions(config),
    logger: agentLogger,
  });
  const registration = await agent.agent.register();
  stderr(`agent kaydı ${registration.status}: ${registration.agentRecord.toBase58()} (${agent.agent.did})`);
  const running = await serveDemoAgent(agent, { port: args.port, host: args.host, onError: reportFailure });
  stderr(
    `agent dinliyor: ${running.url} (kart ${agent.agent.cardUrl}); alacak listeleme ${run.listClaims ? 'açık' : 'kapalı'}; durdurmak için Ctrl+C`,
  );
  await waitForSignal();
  await running.close();
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), process.env);
  if (args.command === 'agent') return runAgentCommand(args);
  const config = loadDemoConfig(args.config);
  if (args.command === 'seed') {
    const keys = loadKeys(config.cluster, SEED_ROLES, ['screener']);
    const result = await runSeed(createContext(config.cluster, keys, stderr), config, {
      rotatePolicySecret: args.rotatePolicySecret,
    });
    const json = JSON.stringify(result, null, 2);
    process.stdout.write(`${json}\n`);
    if (config.seed?.output) {
      writeText(config.seed.output, json);
      stderr(`seed çıktısı: ${config.seed.output}`);
    }
    stderr(`seed: ${result.changes} değişiklik`);
    return;
  }
  const keys = loadKeys(config.cluster, args.agentUrl ? SCENARIO_ROLES : [...SCENARIO_ROLES, 'agent']);
  const context = createContext(config.cluster, keys, stderr);
  const agentWallet = agentWalletFor(config, keys);
  const agent = args.agentUrl
    ? externalAgent({ baseUrl: args.agentUrl, apiKey: requireA2aKey(process.env) })
    : inProcessAgent(context, config);
  const runId = newRunId();
  try {
    const outcomes = await runScenarios({ context, config, names: args.scenarios, agent, agentWallet, runId });
    for (const outcome of outcomes) process.stdout.write(`${outcomeLine(outcome)}\n`);
    if (args.out) {
      writeText(args.out, JSON.stringify({ runId, cluster: config.cluster.cluster, scenarios: outcomes }, null, 2));
      stderr(`sonuç: ${args.out}`);
    }
  } finally {
    await releaseProverWorkers();
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      reportFailure(error);
      process.exit(1);
    },
  );
}
