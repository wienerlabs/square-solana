// Yapılandırma, alarmlar, HTTP yüzeyi, hesap boyutları ve Token-2022 hesap rent'i, döngü.
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Idl } from '@anchor-lang/core';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { createEventWindow, createHealth, createLogger } from '@squaresdk/solana-observability';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keeperAlarmRules } from '../src/alarms.js';
import { createApp, createMetricsApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startLoop } from '../src/loop.js';
import { createMetrics } from '../src/metrics.js';
import { accountSpace, createStateReader, fixedSize } from '../src/state.js';
import { FixtureRpc, startRpc, type RpcServer } from './fixtures/rpc.js';
import { NOW, World } from './fixtures/world.js';

const keeper = Keypair.generate();
const ENV = {
  DATABASE_URL: 'postgres://keeper@db.internal:5432/square',
  KEEPER_RPC_URLS: 'https://rpc-a.example.com, https://rpc-b.example.com',
  KEEPER_RPC_TIMEOUT_MS: '5000',
  KEEPER_RPC_COOLDOWN_MS: '30000',
  KEEPER_SECRET_KEY: bs58.encode(keeper.secretKey),
  KEEPER_PORT: '8080',
  KEEPER_METRICS_PORT: '9464',
  KEEPER_POLL_INTERVAL_MS: '10000',
  KEEPER_CONFIRM_POLL_MS: '1000',
  KEEPER_BATCH_SIZE: '50',
  KEEPER_BACKOFF_BASE_SECONDS: '60',
  KEEPER_BACKOFF_MAX_SECONDS: '3600',
  KEEPER_MINT_UNITS_PER_SOL: '150000000',
  KEEPER_MIN_MARGIN_BPS: '2000',
  KEEPER_PRIORITY_FEE_PERCENTILE: '75',
  KEEPER_MAX_COMPUTE_UNIT_PRICE: '100000',
  KEEPER_ALERT_MIN_BALANCE_LAMPORTS: '100000000',
  KEEPER_ALERT_STALL_SECONDS: '300',
  KEEPER_ALERT_DUE_SECONDS: '600',
  KEEPER_ALERT_ERRORS: '5',
  KEEPER_ALERT_ERROR_WINDOW_SECONDS: '600',
  LOG_LEVEL: 'info',
  HEALTH_CHECK_TIMEOUT_MS: '2000',
  ALERT_EVALUATION_SECONDS: '15',
};

describe('yapılandırma', () => {
  it('geçerli ortam', () => {
    const config = loadConfig(ENV);
    expect(config.keeper.publicKey.equals(keeper.publicKey)).toBe(true);
    expect(config).toMatchObject({
      rpc: { urls: ['https://rpc-a.example.com', 'https://rpc-b.example.com'] },
      economics: {
        mintUnitsPerSol: 150_000_000n,
        minMarginBps: 2_000,
        priorityFeePercentile: 75,
        maxComputeUnitPrice: 100_000n,
      },
      backoff: { baseSeconds: 60, maxSeconds: 3_600 },
      alerts: { minBalanceLamports: 100_000_000n },
    });
  });

  it('geçersiz değerler; gizli anahtar hata mesajına yazılmaz', () => {
    const { DATABASE_URL: _db, ...withoutDb } = ENV;
    expect(() => loadConfig({ ...withoutDb, KEEPER_PRIORITY_FEE_PERCENTILE: '101' })).toThrow(
      /DATABASE_URL[\s\S]*KEEPER_PRIORITY_FEE_PERCENTILE/,
    );
    expect(() => loadConfig({ ...ENV, KEEPER_METRICS_PORT: '8080' })).toThrow(/KEEPER_PORT ile aynı/);
    expect(() => loadConfig({ ...ENV, KEEPER_BACKOFF_MAX_SECONDS: '10' })).toThrow(/küçük olamaz/);
    expect(() => loadConfig({ ...ENV, KEEPER_MINT_UNITS_PER_SOL: '0' })).toThrow(/sıfır olamaz/);
    const short = bs58.encode(keeper.secretKey.subarray(0, 32));
    let message = '';
    try {
      loadConfig({ ...ENV, KEEPER_SECRET_KEY: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('64 baytlık');
    expect(message).not.toContain(short);
    expect(() => loadConfig({ ...ENV, KEEPER_SECRET_KEY: '0OIl' })).toThrow(/base58 gizli anahtar/);
  });
});

describe('alarmlar', () => {
  it('düşük bakiye eksiği, durma süresi, birikim ve hatalar', () => {
    let now = 10_000;
    let balance: bigint | null = null;
    let round: number | null = null;
    let oldestDue: number | null = null;
    const errors = createEventWindow({ windowSeconds: 60, clock: () => now });
    const rules = keeperAlarmRules({
      lastRoundAt: () => round,
      lastBalance: () => balance,
      oldestDueSeconds: () => oldestDue,
      startedAt: 4_000,
      errors,
      thresholds: { minBalanceLamports: 1_000n, stallSeconds: 300, dueSeconds: 600, errors: 5, errorWindowSeconds: 60 },
      clock: () => now,
    });
    const read = (name: string) => rules.find((rule) => rule.name === name)!.read();
    expect(read('keeper_low_balance')).toBe(0);
    balance = 400n;
    expect(read('keeper_low_balance')).toBe(600);
    balance = 5_000n;
    expect(read('keeper_low_balance')).toBe(0);
    expect(read('keeper_stalled')).toBe(6);
    round = 9_000;
    expect(read('keeper_stalled')).toBe(1);
    expect(read('keeper_backlog')).toBe(0);
    oldestDue = 900;
    expect(read('keeper_backlog')).toBe(900);
    expect(rules.find((rule) => rule.name === 'keeper_backlog')!.above).toBe(600);
    errors.record();
    expect(read('keeper_errors')).toBe(1);
    now += 1;
  });
});

describe('HTTP yüzeyi', () => {
  it('health, ready, metrikler ve 404', async () => {
    const log = createLogger({ service: 'keeper-test', level: 'error' });
    let up = true;
    const health = createHealth({
      version: '0.0.0',
      checks: {
        rpc: () => {
          if (!up) throw new Error('rpc down');
        },
      },
      timeoutMs: 1_000,
      logger: log,
    });
    const app = createApp({ health }).listen(0, '127.0.0.1');
    const metricsApp = createMetricsApp(createMetrics({ service: 'keeper-test', version: '0' }).registry, log).listen(
      0,
      '127.0.0.1',
    );
    await Promise.all([once(app, 'listening'), once(metricsApp, 'listening')]);
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const metricsUrl = `http://127.0.0.1:${(metricsApp.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}/health`)).status).toBe(200);
      expect((await fetch(`${url}/ready`)).status).toBe(200);
      up = false;
      expect((await fetch(`${url}/ready`)).status).toBe(503);
      expect((await fetch(`${url}/nope`)).status).toBe(404);
      expect(await (await fetch(`${metricsUrl}/metrics`)).text()).toContain('keeper_balance_lamports');
      expect((await fetch(`${metricsUrl}/nope`)).status).toBe(404);
    } finally {
      app.close();
      metricsApp.close();
    }
  });
});

describe('hesap boyutları', () => {
  let rpc: FixtureRpc;
  let server: RpcServer;
  let world: World;
  beforeAll(async () => {
    rpc = new FixtureRpc();
    server = await startRpc(rpc);
    world = new World(rpc, null, server.url);
  });
  afterAll(() => server.close());

  it('sabit boyutlu hesaplar IDL’den; değişken boyutlu tip hata verir', () => {
    const idl = world.programs.escrow.idl as Idl;
    expect(accountSpace(idl, 'validationRecord')).toBe(150);
    expect(accountSpace(idl, 'agentReputation')).toBe(89);
    expect(() => accountSpace(idl, 'job')).toThrow(/değişken boyutlu/);
    expect(() => fixedSize(idl, { vec: 'u8' })).toThrow(/değişken boyutlu/);
    expect(() => fixedSize(idl, { defined: { name: 'nope' } })).toThrow(/tip yok/);
    expect(fixedSize(idl, { array: ['u16', 3] })).toBe(6);
    expect(fixedSize(idl, 'i128')).toBe(16);
  });

  it('Token-2022 mint’inde token hesabı ImmutableOwner uzantısıyla; zincirde olmayan job ve mint', async () => {
    await world.setup();
    rpc.accounts.set(world.mint.toBase58(), {
      ...rpc.accounts.get(world.mint.toBase58())!,
      owner: TOKEN_2022_PROGRAM_ID.toBase58(),
    });
    const reader = createStateReader({
      client: world.client,
      connection: world.client.escrow.program.provider.connection,
    });
    const job = world.key();
    await world.put(
      'escrow',
      'job',
      job,
      world.sample('escrow', 'job', { mint: world.mint, status: { delivered: {} }, policy: null }),
    );
    const state = (await reader.read(job, NOW, 50))!;
    expect(state.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(state.newAccountSizes).toEqual([150, 89, 170, 170]);
    expect(await reader.read(world.key(), NOW, 50)).toBeNull();
    rpc.accounts.delete(world.mint.toBase58());
    await expect(reader.read(job, NOW, 50)).rejects.toThrow(/mint zincirde yok/);
  });
});

describe('döngü', () => {
  it('koşular üst üste binmez; hata döngüyü durdurmaz', async () => {
    let runs = 0;
    const errors: unknown[] = [];
    const stop = startLoop({
      intervalMs: 5,
      immediate: true,
      run: async () => {
        runs += 1;
        if (runs === 2) throw new Error('rpc down');
      },
      onError: (error) => errors.push(error),
    });
    while (runs < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    await stop();
    expect(runs).toBeGreaterThan(2);
    expect(errors).toHaveLength(1);
    expect(() => startLoop({ intervalMs: 0, immediate: false, run: async () => {}, onError: () => {} })).toThrow();
  });
});

describe('paket bilgisi', () => {
  it('ad ve sürüm', async () => {
    const { packageInfo, parsePackageInfo } = await import('../src/package-info.js');
    expect(packageInfo.name).toBe('@squaresdk/solana-keeper');
    expect(() => parsePackageInfo({ version: '1' })).toThrow(/ad ve sürüm/);
  });
});
