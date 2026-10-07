import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { isEntryPoint, reportFailure, stderr, writeText } from '@squaresdk/solana-smoke/cli';
import { createContext, type Context } from '@squaresdk/solana-smoke/context';
import { loadRoleKeys, roleKey } from '@squaresdk/solana-smoke/keys';
import { loadCircuitArtifacts, localProver, releaseProverWorkers } from '@squaresdk/solana-smoke/prover';
import { newRunId } from '@squaresdk/solana-smoke/smoke';
import { callerGrants, createDemoAgent, serveDemoAgent, type RunningAgent } from './agent.js';
import { loadDemoConfig, requireDemo, selectScenarios, type DemoConfig } from './demo-config.js';
import { runScenario, type AgentEndpoint, type ScenarioOutcome } from './scenario.js';
import { runSeed } from './seed.js';

export const A2A_KEY_ENV = 'SQUARE_DEMO_A2A_KEY';
export const CONFIG_ENV = 'SQUARE_DEMO_CONFIG';

export const USAGE = [
  'kullanım:',
  '  seed     --config <küme.json>',
  '  scenario --config <küme.json> [--scenario <ad>]... [--agent-url <http(s)://…>] [--out <sonuç.json>]',
  '  agent    --config <küme.json> [--port 8787] [--host 127.0.0.1] [--institution <adres>]...',
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
  const port = Number(values.port ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port geçersiz: ${values.port}`);
  const agentUrl = values['agent-url']?.replace(/\/+$/, '') ?? null;
  if (agentUrl !== null && !/^https?:\/\//.test(agentUrl))
    throw new Error(`--agent-url http(s) adresi olmalı: ${agentUrl}`);
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
  };
}

export function requireA2aKey(env: NodeJS.ProcessEnv): string {
  const key = env[A2A_KEY_ENV]?.trim();
  if (!key) throw new Error(`${A2A_KEY_ENV} ortam değişkeni gerekli (agent ile kurumun paylaştığı A2A anahtarı)`);
  return key;
}

const agentLogger = {
  info: (message: string) => stderr(`agent: ${message}`),
  error: (message: string) => stderr(`agent hata: ${message}`),
};

export function txOptions(context: Context) {
  const { computeUnitPrice, lookupTable } = context.config;
  return {
    ...(computeUnitPrice === undefined ? {} : { computeUnitPrice: BigInt(computeUnitPrice) }),
    ...(lookupTable ? { addressLookupTables: [lookupTable] } : {}),
  };
}

export async function startInProcessAgent(
  context: Context,
  config: DemoConfig,
  apiKey: string,
  options: { port: number; host: string; institutions: readonly string[] },
): Promise<RunningAgent> {
  const demo = requireDemo(config);
  const agent = await createDemoAgent({
    settings: demo.agent,
    signer: roleKey(context.keys, 'agent'),
    connection: context.connection,
    commitment: context.config.commitment,
    programIds: context.config.programIds,
    callers: callerGrants(apiKey, options.institutions),
    tx: txOptions(context),
    logger: agentLogger,
  });
  return serveDemoAgent(agent, { port: options.port, host: options.host, onError: (error) => reportFailure(error) });
}

export async function runScenarios(params: {
  context: Context;
  config: DemoConfig;
  names: readonly string[];
  endpoint: AgentEndpoint;
  runId: string;
}): Promise<ScenarioOutcome[]> {
  const demo = requireDemo(params.config);
  const prover = localProver(loadCircuitArtifacts());
  const outcomes: ScenarioOutcome[] = [];
  for (const [name, scenario] of selectScenarios(demo, params.names)) {
    outcomes.push(
      await runScenario({
        context: params.context,
        config: params.config,
        name,
        scenario,
        agent: params.endpoint,
        prover,
        runId: params.runId,
      }),
    );
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

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), process.env);
  const config = loadDemoConfig(args.config);
  const context = createContext(config.cluster, loadRoleKeys(config.cluster), stderr);
  if (args.command === 'seed') {
    const result = await runSeed(context, config);
    const json = JSON.stringify(result, null, 2);
    process.stdout.write(`${json}\n`);
    if (config.seed?.output) {
      writeText(config.seed.output, json);
      stderr(`seed çıktısı: ${config.seed.output}`);
    }
    stderr(`seed: ${result.changes} değişiklik`);
    return;
  }
  if (args.command === 'agent') {
    const institutions =
      args.institutions.length > 0 ? args.institutions : [roleKey(context.keys, 'institution').publicKey.toBase58()];
    const demo = requireDemo(config);
    const agent = await createDemoAgent({
      settings: demo.agent,
      signer: roleKey(context.keys, 'agent'),
      connection: context.connection,
      commitment: context.config.commitment,
      programIds: context.config.programIds,
      callers: callerGrants(requireA2aKey(process.env), institutions),
      tx: txOptions(context),
      logger: agentLogger,
    });
    const registration = await agent.agent.register();
    stderr(`agent kaydı ${registration.status}: ${registration.agentRecord.toBase58()} (${agent.agent.did})`);
    const running = await serveDemoAgent(agent, { port: args.port, host: args.host, onError: reportFailure });
    stderr(`agent dinliyor: ${running.url} (kart ${agent.agent.cardUrl}); durdurmak için Ctrl+C`);
    await waitForSignal();
    await running.close();
    return;
  }
  const runId = newRunId();
  let running: RunningAgent | null = null;
  try {
    let endpoint: AgentEndpoint;
    if (args.agentUrl) {
      endpoint = { baseUrl: args.agentUrl, apiKey: requireA2aKey(process.env) };
    } else {
      const apiKey = randomBytes(32).toString('hex');
      running = await startInProcessAgent(context, config, apiKey, {
        port: 0,
        host: '127.0.0.1',
        institutions: [roleKey(context.keys, 'institution').publicKey.toBase58()],
      });
      endpoint = { baseUrl: running.url, apiKey };
      stderr(`agent (süreç içi): ${running.url}`);
    }
    const outcomes = await runScenarios({ context, config, names: args.scenarios, endpoint, runId });
    for (const outcome of outcomes) process.stdout.write(`${outcomeLine(outcome)}\n`);
    if (args.out) {
      writeText(args.out, JSON.stringify({ runId, cluster: config.cluster.cluster, scenarios: outcomes }, null, 2));
      stderr(`sonuç: ${args.out}`);
    }
  } finally {
    await running?.close();
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
