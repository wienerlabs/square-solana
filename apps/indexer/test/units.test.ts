// Yapılandırma, döngü, alarm kuralları, webhook gövdesi ve ayna eşlemesinin hata yolları.
import { createEventWindow } from '@squaresdk/solana-observability';
import { describe, expect, it } from 'vitest';
import { indexerAlarmRules } from '../src/alarms.js';
import { loadConfig } from '../src/config.js';
import { startLoop } from '../src/loop.js';
import { TABLES, disputeColumns } from '../src/mirror.js';
import { canonicalJson } from '../src/reconcile.js';
import { webhookSignatures } from '../src/webhook.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://indexer@db.internal:5432/square',
  INDEXER_RPC_URLS: 'https://rpc-a.example.com/?api-key=x, https://rpc-b.example.com',
  INDEXER_RPC_TIMEOUT_MS: '5000',
  INDEXER_RPC_COOLDOWN_MS: '30000',
  INDEXER_PORT: '8080',
  INDEXER_METRICS_PORT: '9464',
  INDEXER_POLL_INTERVAL_MS: '2000',
  INDEXER_SIGNATURE_PAGE_SIZE: '1000',
  INDEXER_RECONCILE_INTERVAL_SECONDS: '600',
  INDEXER_ALERT_STALL_SECONDS: '120',
  INDEXER_ALERT_LAG_SLOTS: '150',
  INDEXER_ALERT_DRIFT: '0',
  INDEXER_ALERT_ERRORS: '5',
  INDEXER_ALERT_ERROR_WINDOW_SECONDS: '60',
  LOG_LEVEL: 'info',
  HEALTH_CHECK_TIMEOUT_MS: '2000',
  ALERT_EVALUATION_SECONDS: '15',
};
const WEBHOOK_ENV = {
  INDEXER_WEBHOOK_AUTH_SHA256: 'a'.repeat(64),
  INDEXER_WEBHOOK_MAX_BODY_BYTES: '1048576',
  INDEXER_WEBHOOK_MAX_PENDING: '10000',
  INDEXER_WEBHOOK_PENDING_TTL_SECONDS: '300',
};

describe('yapılandırma', () => {
  it('geçerli ortam; webhook isteğe bağlı', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.rpc.urls).toEqual(['https://rpc-a.example.com/?api-key=x', 'https://rpc-b.example.com']);
    expect(config.webhook).toBeNull();
    expect(config).toMatchObject({
      port: 8080,
      metricsPort: 9464,
      signaturePageSize: 1000,
      reconcileIntervalSeconds: 600,
    });
    expect(loadConfig({ ...BASE_ENV, INDEXER_WEBHOOK_AUTH_SHA256: '' }).webhook).toBeNull();
    expect(loadConfig({ ...BASE_ENV, ...WEBHOOK_ENV }).webhook).toEqual({
      authSha256: 'a'.repeat(64),
      maxBodyBytes: 1_048_576,
      maxPending: 10_000,
      pendingTtlSeconds: 300,
    });
  });

  it('eksik ve geçersiz değerler hepsi birden raporlanır', () => {
    const { DATABASE_URL: _url, ...withoutDb } = BASE_ENV;
    expect(() =>
      loadConfig({
        ...withoutDb,
        INDEXER_RPC_URLS: 'ftp://rpc',
        INDEXER_SIGNATURE_PAGE_SIZE: '1001',
        LOG_LEVEL: 'loud',
      }),
    ).toThrow(/DATABASE_URL[\s\S]*INDEXER_RPC_URLS[\s\S]*INDEXER_SIGNATURE_PAGE_SIZE[\s\S]*LOG_LEVEL/);
    expect(() => loadConfig({ ...BASE_ENV, INDEXER_METRICS_PORT: '8080' })).toThrow(/INDEXER_PORT ile aynı/);
    expect(() => loadConfig({ ...BASE_ENV, INDEXER_WEBHOOK_AUTH_SHA256: 'a'.repeat(64) })).toThrow(
      /INDEXER_WEBHOOK_MAX_BODY_BYTES: INDEXER_WEBHOOK_AUTH_SHA256 verilince zorunlu/,
    );
    expect(() => loadConfig({ ...BASE_ENV, ...WEBHOOK_ENV, INDEXER_WEBHOOK_AUTH_SHA256: 'xyz' })).toThrow(
      /64 küçük harf/,
    );
  });
});

describe('döngü', () => {
  it('koşular üst üste binmez; hata döngüyü durdurmaz; durdurma süren koşuyu bekler', async () => {
    let runs = 0;
    let active = 0;
    let overlap = false;
    const errors: unknown[] = [];
    const stop = startLoop({
      intervalMs: 5,
      immediate: true,
      run: async () => {
        runs += 1;
        active += 1;
        overlap ||= active > 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        if (runs === 2) throw new Error('rpc down');
      },
      onError: (error) => errors.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await stop();
    const stoppedAt = runs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toBe(stoppedAt);
    expect(runs).toBeGreaterThan(2);
    expect(overlap).toBe(false);
    expect(errors).toHaveLength(1);
    expect(active).toBe(0);
  });

  it('gecikmeli başlangıç ve geçersiz aralık', async () => {
    let runs = 0;
    const stop = startLoop({ intervalMs: 50, immediate: false, run: async () => void (runs += 1), onError: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await stop();
    expect(runs).toBe(0);
    expect(() => startLoop({ intervalMs: 0, immediate: true, run: async () => {}, onError: () => {} })).toThrow();
  });
});

describe('alarm kuralları', () => {
  it('durma süresi, senkron gecikmesi, sapma ve hata sayısı', () => {
    let now = 10_000;
    let lastPoll: number | null = null;
    let lag: number | null = null;
    let drift: number | null = null;
    const errors = createEventWindow({ windowSeconds: 60, clock: () => now });
    const rules = indexerAlarmRules({
      lastPollAt: () => lastPoll,
      startedAt: 4_000,
      syncLag: () => lag,
      lastDrift: () => drift,
      errors,
      thresholds: { stallSeconds: 120, lagSlots: 150, drift: 0, errors: 5, errorWindowSeconds: 60 },
      clock: () => now,
    });
    const value = (name: string) => rules.find((rule) => rule.name === name)!.read();
    expect(value('indexer_stalled')).toBe(6);
    lastPoll = 9_000;
    expect(value('indexer_stalled')).toBe(1);
    expect(value('indexer_lagging')).toBe(0);
    lag = 200;
    expect(value('indexer_lagging')).toBe(200);
    expect(rules.find((rule) => rule.name === 'indexer_lagging')!.above).toBe(150);
    expect(value('indexer_reconcile_drift')).toBe(0);
    drift = 3;
    expect(value('indexer_reconcile_drift')).toBe(3);
    errors.record();
    expect(value('indexer_errors')).toBe(1);
    now += 1;
    expect(rules.map((rule) => rule.severity)).toEqual(['critical', 'warning', 'warning', 'critical']);
  });
});

describe('webhook gövdesi', () => {
  const sig = '5'.repeat(88);
  it('raw tx biçiminden imzalar', () => {
    expect(webhookSignatures([{ transaction: { signatures: [sig] } }, { signature: sig }])).toEqual([sig, sig]);
    expect(webhookSignatures([])).toEqual([]);
  });
  it('geçersiz gövde', () => {
    expect(webhookSignatures({ signature: sig })).toBeNull();
    expect(webhookSignatures([null])).toBeNull();
    expect(webhookSignatures([{ transaction: { signatures: 'x' } }])).toBeNull();
    expect(webhookSignatures([{ signature: '0OIl' }])).toBeNull();
  });
});

describe('ayna eşlemesi', () => {
  it('beklenmeyen JSON biçimi hata verir', () => {
    expect(() => TABLES.Policy.columns({ institution: 1, policyId: 'a', version: 1, active: true })).toThrow(/dize/);
    expect(() => TABLES.Policy.columns({ institution: 'a', policyId: 'a', version: '1', active: true })).toThrow(
      /sayı/,
    );
    expect(() => TABLES.Policy.columns({ institution: 'a', policyId: 'a', version: 1, active: 'yes' })).toThrow(
      /boolean/,
    );
    expect(() => TABLES.ScreeningRecord.columns({ wallet: 'w', status: 'clear', screenedAt: '1' })).toThrow(/tamsayı/);
    expect(() => disputeColumns({ dispute: null })).toThrow(/nesne/);
  });
  it('anahtar sırasından bağımsız JSON', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(canonicalJson({ a: null, b: [1, { c: 2, d: 1 }] }));
  });
});
