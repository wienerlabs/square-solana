#!/usr/bin/env node
// Localnet koşucusu (`smoke:localnet`): `solana-test-validator`'ı dört programla (`--upgradeable-program`,
// `target/deploy/*.so`; upgrade authority koşunun ürettiği geçici anahtar) başlatır, 6 ondalıklı bir test
// mint'i ve rol anahtarları üretir, `init` ve `smoke`'u aynı komutlarla gerçek işlemlerle koşar, raporu
// `docs/deploy/smoke-localnet.md`'ye yazar ve validator'ı kapatır. Anahtarlar depo dışında geçici bir dizinde
// üretilir ve koşu bitince silinir. Programlar derlenmez (`anchor build` ayrı adımdır).
//
//   node dist/localnet.js [--deploy-dir target/deploy] [--ledger <dizin>] [--rpc-port 8899]
//     [--faucet-port 9900] [--gossip-port 8001] [--dynamic-port-range 8100-8200] [--report <rapor.md>]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js';
import { executableHash } from './chain.js';
import { defaultReportPath, isEntryPoint, reportFailure, stderr, writeText } from './cli.js';
import { loadClusterConfig } from './config.js';
import { createContext } from './context.js';
import { runInit } from './init.js';
import { loadRoleKeys, REPO_ROOT } from './keys.js';
import { loadCircuitArtifacts, localProver, releaseProverWorkers } from './prover.js';
import { smokeReportMarkdown, type InitRecord } from './render.js';
import { runSmoke } from './smoke.js';

const PROGRAMS = [
  ['registry', 'square_registry'],
  ['policy', 'square_policy'],
  ['verifier', 'square_verifier'],
  ['escrow', 'square_escrow'],
] as const;

/** Program kimlikleri: `Anchor.toml [programs.localnet]` (programların `declare_id!` değerleri). */
export function localnetProgramIds(anchorToml: string): Record<(typeof PROGRAMS)[number][0], string> {
  const section = /\[programs\.localnet\]([\s\S]*?)(?:\n\[|$)/.exec(anchorToml)?.[1];
  if (!section) throw new Error('Anchor.toml: [programs.localnet] yok');
  const ids = Object.fromEntries(
    PROGRAMS.map(([name, crate]) => {
      const id = new RegExp(`^${crate}\\s*=\\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"`, 'm').exec(section)?.[1];
      if (!id) throw new Error(`Anchor.toml: [programs.localnet] içinde ${crate} yok`);
      return [name, id];
    }),
  );
  return ids as Record<(typeof PROGRAMS)[number][0], string>;
}

export type LocalnetProgramIds = ReturnType<typeof localnetProgramIds>;

export interface LocalnetArgs {
  deployDir: string;
  ledger: string;
  rpcPort: number;
  faucetPort: number;
  gossipPort: number;
  dynamicPortRange: string;
  report: string;
}

export function parseLocalnetArgs(argv: readonly string[]): LocalnetArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'deploy-dir': { type: 'string' },
      ledger: { type: 'string' },
      'rpc-port': { type: 'string' },
      'faucet-port': { type: 'string' },
      'gossip-port': { type: 'string' },
      'dynamic-port-range': { type: 'string' },
      report: { type: 'string' },
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
    ledger: resolve(values.ledger ?? join(tmpdir(), 'square-smoke-ledger')),
    rpcPort: port(values['rpc-port'], 8899, 'rpc-port'),
    faucetPort: port(values['faucet-port'], 9900, 'faucet-port'),
    gossipPort: port(values['gossip-port'], 8001, 'gossip-port'),
    dynamicPortRange: range,
    report: resolve(values.report ?? defaultReportPath('localnet')),
  };
}

/** Localnet'in init ve smoke değerleri (yapılandırma şemasının girdisi). */
export function localnetConfig(params: {
  rpcUrl: string;
  programIds: Record<string, string>;
  mint: PublicKey;
  arbitrators: readonly PublicKey[];
  screener: PublicKey;
  mppAuthority: PublicKey;
}) {
  return {
    cluster: 'localnet',
    rpcUrl: params.rpcUrl,
    commitment: 'confirmed',
    programIds: params.programIds,
    settlementMint: params.mint.toBase58(),
    computeUnitPrice: 1_000,
    keys: {
      payer: 'payer.json',
      admin: 'admin.json',
      screener: 'screener.json',
      institution: 'institution.json',
      agent: 'agent.json',
      buyer: 'buyer.json',
      keeper: 'keeper.json',
      mppAuthority: 'mppAuthority.json',
    },
    init: {
      registry: { screenerAuthority: params.screener.toBase58(), screeningTtlSecs: 86_400 },
      verifier: { mppAuthority: params.mppAuthority.toBase58() },
      escrow: {
        arbitrators: params.arbitrators.map((key) => key.toBase58()),
        threshold: 2,
        params: {
          // Localnet: challenge penceresi kısa (finalize ispatla aynı UTC gününde kalır, ADR 0012).
          minChallengePeriod: 1,
          maxChallengePeriod: 2_592_000,
          minBondBps: 500,
          minBondAbsolute: 1_000_000,
          keeperFeeBps: 50,
          proofTimeoutSecs: 86_400,
          disputeTimeoutSecs: 604_800,
          travelRuleThreshold: 3_000_000_000,
        },
      },
    },
    smoke: {
      jobAmount: 25_000_000,
      claimPrice: 24_000_000,
      challengePeriodSecs: 5,
      deadlineSecs: 3_600,
      paymentCategory: 'research',
    },
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitForRpc(connection: Connection, validator: ChildProcess, timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (validator.exitCode !== null) throw new Error(`solana-test-validator çıktı (kod ${validator.exitCode})`);
    try {
      if ((await connection.getSlot('confirmed')) > 1) return;
    } catch {
      // RPC henüz açılmadı.
    }
    if (Date.now() - started > timeoutMs) throw new Error('solana-test-validator RPC zaman aşımı');
    await sleep(500);
  }
}

async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<void> {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
}

function stop(validator: ChildProcess): Promise<void> {
  if (validator.exitCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => validator.kill('SIGKILL'), 10_000);
    validator.once('exit', () => (clearTimeout(timer), done()));
    validator.kill('SIGTERM');
  });
}

export const LOCALNET_ROLES = [
  'admin',
  'payer',
  'screener',
  'institution',
  'agent',
  'buyer',
  'keeper',
  'mintAuthority',
  'mppAuthority',
] as const;
export type LocalnetRole = (typeof LOCALNET_ROLES)[number];
export type LocalnetKeys = Record<LocalnetRole, Keypair>;

export function writeRoleKeys(dir: string): LocalnetKeys {
  return Object.fromEntries(
    LOCALNET_ROLES.map((role) => {
      const keypair = Keypair.generate();
      writeFileSync(join(dir, `${role}.json`), JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
      return [role, keypair];
    }),
  ) as LocalnetKeys;
}

export type ValidatorArgs = Omit<LocalnetArgs, 'report'>;

export interface LocalValidator {
  readonly rpcUrl: string;
  readonly connection: Connection;
  readonly agave: string;
  readonly logPath: string;
  stop(): Promise<void>;
}

export function validatorArgs(
  args: ValidatorArgs,
  programIds: LocalnetProgramIds,
  upgradeAuthority: PublicKey,
): string[] {
  return [
    '--reset',
    '--quiet',
    '--ledger',
    args.ledger,
    '--rpc-port',
    String(args.rpcPort),
    '--faucet-port',
    String(args.faucetPort),
    '--gossip-port',
    String(args.gossipPort),
    '--dynamic-port-range',
    args.dynamicPortRange,
    ...PROGRAMS.flatMap(([name, crate]) => [
      '--upgradeable-program',
      programIds[name],
      join(args.deployDir, `${crate}.so`),
      upgradeAuthority.toBase58(),
    ]),
  ];
}

const PORT_PROBE_TIMEOUT_MS = 1_000;

export function acceptsConnections(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const settle = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

export async function assertValidatorPortsFree(
  args: Pick<ValidatorArgs, 'rpcPort' | 'faucetPort' | 'gossipPort'>,
): Promise<void> {
  for (const [name, port] of [
    ['RPC', args.rpcPort],
    ['faucet', args.faucetPort],
    ['gossip', args.gossipPort],
  ] as const) {
    if (await acceptsConnections(port)) {
      throw new Error(
        `validator başlatılmadı: ${name} portu ${port} zaten bağlantı kabul ediyor (127.0.0.1:${port}); ` +
          'o portta başka bir validator ya da servis çalışıyor olabilir',
      );
    }
  }
}

export async function startValidator(params: {
  args: ValidatorArgs;
  programIds: LocalnetProgramIds;
  upgradeAuthority: PublicKey;
  logPath: string;
}): Promise<LocalValidator> {
  await assertValidatorPortsFree(params.args);
  const version = spawnSync('solana-test-validator', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error("solana-test-validator bulunamadı (Agave CLI PATH'te olmalı)");
  const agave = /^solana-test-validator\s+(\S+)/.exec(version.stdout.trim())?.[1] ?? version.stdout.trim();
  const log = createWriteStream(params.logPath);
  const child = spawn('solana-test-validator', validatorArgs(params.args, params.programIds, params.upgradeAuthority), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const rpcUrl = `http://127.0.0.1:${params.args.rpcPort}`;
  const connection = new Connection(rpcUrl, 'confirmed');
  const validator: LocalValidator = { rpcUrl, connection, agave, logPath: params.logPath, stop: () => stop(child) };
  try {
    await waitForRpc(connection, child);
  } catch (error) {
    await validator.stop();
    throw error;
  }
  return validator;
}

export const LOCALNET_AIRDROPS: readonly (readonly [LocalnetRole, number])[] = [
  ['payer', 100],
  ['admin', 10],
  ['keeper', 10],
];

export async function fundLocalnet(params: {
  connection: Connection;
  rpcUrl: string;
  programIds: LocalnetProgramIds;
  key: LocalnetKeys;
  airdrops?: readonly (readonly [LocalnetRole, number])[];
}): Promise<ReturnType<typeof localnetConfig>> {
  const { connection, key } = params;
  for (const [role, sol] of params.airdrops ?? LOCALNET_AIRDROPS) {
    await airdrop(connection, key[role].publicKey, sol);
  }
  const mint = await createMint(connection, key.payer, key.mintAuthority.publicKey, null, 6);
  const arbitrators = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => k.publicKey);
  const config = localnetConfig({
    rpcUrl: params.rpcUrl,
    programIds: params.programIds,
    mint,
    arbitrators,
    screener: key.screener.publicKey,
    mppAuthority: key.mppAuthority.publicKey,
  });
  for (const [role, amount] of [
    ['institution', BigInt(config.smoke.jobAmount) * 10n],
    ['buyer', BigInt(config.smoke.claimPrice) * 10n],
  ] as const) {
    const account = await getOrCreateAssociatedTokenAccount(connection, key.payer, mint, key[role].publicKey);
    await mintTo(connection, key.payer, mint, account.address, key.mintAuthority, amount);
  }
  return config;
}

export function assertDeployedPrograms(record: InitRecord, deployDir: string): void {
  for (const program of record.programs) {
    const local = executableHash(readFileSync(join(deployDir, `${program.name}.so`)));
    if (local !== program.executableHash) {
      throw new Error(`${program.name}: zincirdeki executable hash ${program.executableHash}, .so ${local}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseLocalnetArgs(process.argv.slice(2));
  const programIds = localnetProgramIds(readFileSync(join(REPO_ROOT, 'Anchor.toml'), 'utf8'));
  const artifacts = loadCircuitArtifacts();
  const keysDir = mkdtempSync(join(tmpdir(), 'square-smoke-keys-'));
  const key = writeRoleKeys(keysDir);
  const logPath = join(keysDir, 'validator.log');
  let validator: LocalValidator | null = null;
  try {
    validator = await startValidator({ args, programIds, upgradeAuthority: key.admin.publicKey, logPath });
    const { connection, rpcUrl, agave } = validator;
    stderr(`localnet: ${agave} · ${rpcUrl}`);
    const config = await fundLocalnet({ connection, rpcUrl, programIds, key });
    const configPath = join(keysDir, 'localnet.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const loaded = loadClusterConfig(configPath, {});
    const keys = loadRoleKeys(loaded);
    const logLine = stderr;
    stderr('init:');
    const init = await runInit(createContext(loaded, keys, logLine));
    assertDeployedPrograms(init.record, args.deployDir);
    stderr('smoke:');
    const smokeConfig = { ...loaded, lookupTable: init.lookupTable ?? undefined };
    const report = await runSmoke(createContext(smokeConfig, keys, logLine), {
      prover: localProver(artifacts),
      init: init.record,
      banner: [
        `**Küme: localnet.** \`solana-test-validator\` (Agave ${agave}) üzerinde, \`smoke:localnet\` koşucusunun ` +
          'açtığı geçici bir zincirde gerçek işlemler. **Devnet raporu değildir**: devnet kaydı gerçek deploy ve ' +
          "smoke'la `docs/deploy/devnet.md` ve `docs/deploy/smoke-devnet.md`'de oluşur (BC-30, BC-31).",
        "Programlar `target/deploy/*.so`'dan `--upgradeable-program` ile yüklendi; zincirdeki executable hash'leri " +
          '`.so` dosyalarınınkiyle aynı. Upgrade authority, rol anahtarları ve mint (6 ondalık) koşu için üretildi ' +
          've koşu bitince silindi; imzalar yalnızca o zincirde geçerlidir.',
      ],
    });
    writeText(args.report, smokeReportMarkdown(report));
    stderr(`rapor: ${args.report}`);
  } catch (error) {
    stderr(`validator günlüğü: ${logPath} (hata durumunda silinmez)`);
    throw error;
  } finally {
    await validator?.stop();
    await releaseProverWorkers();
  }
  rmSync(keysDir, { recursive: true, force: true });
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    // web3.js bağlantısının websocket'i süreci açık tutar.
    () => process.exit(0),
    (error: unknown) => {
      reportFailure(error);
      process.exit(1);
    },
  );
}
