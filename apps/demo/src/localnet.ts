import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { isEntryPoint, reportFailure, stderr, writeText } from '@squaresdk/solana-smoke/cli';
import { createContext } from '@squaresdk/solana-smoke/context';
import { runInit } from '@squaresdk/solana-smoke/init';
import { loadRoleKeys, REPO_ROOT } from '@squaresdk/solana-smoke/keys';
import {
  airdrop,
  assertDeployedPrograms,
  localnetConfig,
  localnetProgramIds,
  startValidator,
  writeRoleKeys,
  type LocalValidator,
  type ValidatorArgs,
} from '@squaresdk/solana-smoke/localnet';
import { releaseProverWorkers } from '@squaresdk/solana-smoke/prover';
import { newRunId } from '@squaresdk/solana-smoke/smoke';
import type { RunningAgent } from './agent.js';
import { outcomeLine, runScenarios, startInProcessAgent } from './cli.js';
import { loadDemoConfig } from './demo-config.js';
import type { ScenarioOutcome } from './scenario.js';
import { runSeed, type SeedResult } from './seed.js';

export const LOCALNET_FAUCET_USDC = 1_000_000_000n;

export interface DemoLocalnetArgs extends ValidatorArgs {
  scenarios: string[];
  out: string | null;
}

export function parseDemoLocalnetArgs(argv: readonly string[]): DemoLocalnetArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'deploy-dir': { type: 'string' },
      ledger: { type: 'string' },
      'rpc-port': { type: 'string' },
      'faucet-port': { type: 'string' },
      'gossip-port': { type: 'string' },
      'dynamic-port-range': { type: 'string' },
      scenario: { type: 'string', multiple: true },
      out: { type: 'string' },
    },
  });
  const port = (value: string | undefined, fallback: number, name: string) => {
    const n = Number(value ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new Error(`--${name} geçersiz: ${value}`);
    return n;
  };
  const range = values['dynamic-port-range'] ?? '8100-8200';
  if (!/^\d+-\d+$/.test(range)) throw new Error(`--dynamic-port-range geçersiz: ${range}`);
  return {
    deployDir: resolve(values['deploy-dir'] ?? join(REPO_ROOT, 'target/deploy')),
    ledger: resolve(values.ledger ?? join(tmpdir(), 'square-demo-ledger')),
    rpcPort: port(values['rpc-port'], 8899, 'rpc-port'),
    faucetPort: port(values['faucet-port'], 9900, 'faucet-port'),
    gossipPort: port(values['gossip-port'], 8001, 'gossip-port'),
    dynamicPortRange: range,
    scenarios: values.scenario ?? [],
    out: values.out ? resolve(values.out) : null,
  };
}

export function demoLocalnetSections(params: { extraBuyers: readonly string[]; escrowProgram: string }) {
  const report = (targets: string[], signatures: number) => ({ targets, signatures });
  return {
    seed: {
      institutionName: 'Square demo kurumu',
      policySecret: 'policy-secret',
      output: 'seed-localnet.json',
      policies: {
        standard: { maxPerTx: '10000000', maxDaily: '100000000', dailyCeiling: '200000000', categories: ['research'] },
        strict: { maxPerTx: '1000000', maxDaily: '100000000', dailyCeiling: '200000000', categories: ['research'] },
      },
      extraBuyers: [...params.extraBuyers],
      funding: {
        institutionUsdc: '50000000',
        buyerUsdc: '20000000',
        agentLamports: '200000000',
        keeperLamports: '100000000',
      },
      screening: { minRemainingSecs: 3_600 },
    },
    demo: {
      agent: {
        agentId: 'square-demo-reporter',
        name: 'Square demo agent',
        description: "Job spec'inde adı geçen Solana hesaplarının zincirdeki durumunu raporlar.",
        version: '1.0.0',
        publicUrl: 'https://demo-agent.localnet.test',
        price: '1000000',
        autoListClaimBps: 300,
      },
      taskTimeoutSecs: 120,
      scenarios: {
        approved: {
          policy: 'standard',
          expect: 'approved',
          amount: '5000000',
          paymentCategory: 'research',
          challengePeriodSecs: 5,
          deadlineSecs: 3_600,
          report: report(['institution', 'institution:usdc', 'mint'], 5),
        },
        'approved-claim': {
          policy: 'standard',
          expect: 'approved',
          amount: '4000000',
          paymentCategory: 'research',
          challengePeriodSecs: 5,
          deadlineSecs: 3_600,
          claimSale: true,
          report: report(['buyer', 'buyer:usdc', 'agent:usdc', 'institution:pda'], 3),
        },
        refused: {
          policy: 'strict',
          expect: 'refused',
          amount: '5000000',
          paymentCategory: 'research',
          challengePeriodSecs: 5,
          deadlineSecs: 3_600,
          report: report(['agent', 'keeper', params.escrowProgram], 2),
        },
      },
    },
  };
}

const seedLine = (index: number, result: SeedResult) =>
  `seed ${index}: ${result.changes} değişiklik; kurum ${result.institution.pda}, agent ${result.agent.agentRecord}, politikalar ${result.policies
    .map((policy) => `${policy.name} ${policy.address}`)
    .join(', ')}`;

async function main(): Promise<void> {
  const args = parseDemoLocalnetArgs(process.argv.slice(2));
  const programIds = localnetProgramIds(readFileSync(join(REPO_ROOT, 'Anchor.toml'), 'utf8'));
  const keysDir = mkdtempSync(join(tmpdir(), 'square-demo-keys-'));
  const key = writeRoleKeys(keysDir);
  const logPath = join(keysDir, 'validator.log');
  let validator: LocalValidator | null = null;
  let running: RunningAgent | null = null;
  try {
    validator = await startValidator({ args, programIds, upgradeAuthority: key.admin.publicKey, logPath });
    const { connection, rpcUrl, agave } = validator;
    stderr(`localnet: ${agave} · ${rpcUrl}`);
    await airdrop(connection, key.payer.publicKey, 100);
    await airdrop(connection, key.admin.publicKey, 10);
    const mint = await createMint(connection, key.payer, key.mintAuthority.publicKey, null, 6);
    const faucet = await getOrCreateAssociatedTokenAccount(connection, key.payer, mint, key.payer.publicKey);
    await mintTo(connection, key.payer, mint, faucet.address, key.mintAuthority, LOCALNET_FAUCET_USDC);
    stderr(`localnet mint ${mint.toBase58()}: payer'a ${LOCALNET_FAUCET_USDC} (faucet yerine)`);

    const raw = {
      ...localnetConfig({
        rpcUrl,
        programIds,
        mint,
        arbitrators: [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => k.publicKey),
        screener: key.screener.publicKey,
        mppAuthority: key.mppAuthority.publicKey,
      }),
      ...demoLocalnetSections({
        extraBuyers: [Keypair.generate(), Keypair.generate()].map((k) => k.publicKey.toBase58()),
        escrowProgram: programIds.escrow,
      }),
    };
    const configPath = join(keysDir, 'localnet.json');
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    const loaded = loadDemoConfig(configPath, {});
    const keys = loadRoleKeys(loaded.cluster);
    stderr('init:');
    const init = await runInit(createContext(loaded.cluster, keys, stderr));
    assertDeployedPrograms(init.record, args.deployDir);
    const cluster = { ...loaded.cluster, lookupTable: init.lookupTable ?? undefined };
    const config = { ...loaded, cluster };
    const context = createContext(cluster, keys, stderr);

    const seeds: SeedResult[] = [];
    for (const index of [1, 2]) {
      stderr(`seed ${index}:`);
      seeds.push(await runSeed(context, config));
    }
    if (seeds[1]!.changes !== 0)
      throw new Error(`seed tekrarı ${seeds[1]!.changes} değişiklik yaptı; tekrar kurulum aynı değil`);

    const apiKey = randomBytes(32).toString('hex');
    running = await startInProcessAgent(context, config, apiKey, {
      port: 0,
      host: '127.0.0.1',
      institutions: [key.institution.publicKey.toBase58()],
    });
    stderr(`agent (süreç içi): ${running.url}`);
    const runId = newRunId();
    const outcomes: ScenarioOutcome[] = await runScenarios({
      context,
      config,
      names: args.scenarios,
      endpoint: { baseUrl: running.url, apiKey },
      runId,
    });

    seeds.forEach((result, index) => process.stdout.write(`${seedLine(index + 1, result)}\n`));
    for (const outcome of outcomes) process.stdout.write(`${outcomeLine(outcome)}\n`);
    if (args.out) {
      writeText(args.out, JSON.stringify({ runId, cluster: 'localnet', agave, seeds, scenarios: outcomes }, null, 2));
      stderr(`sonuç: ${args.out}`);
    }
  } catch (error) {
    stderr(`validator günlüğü: ${logPath} (hata durumunda silinmez)`);
    throw error;
  } finally {
    await running?.close();
    await validator?.stop();
    await releaseProverWorkers();
  }
  rmSync(keysDir, { recursive: true, force: true });
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
