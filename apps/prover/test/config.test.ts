import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiKeyCheck } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const ENV = {
  PROVER_SERVICE_PORT: '8080',
  PROVER_METRICS_PORT: '9464',
  CORS_ORIGINS: 'https://app.example.org, https://admin.example.org',
  PROVER_API_KEY_SHA256: `${sha('birinci anahtar')},${sha('ikinci anahtar')}`,
  PROVER_MAX_CONCURRENT: '2',
  PROVER_MAX_QUEUE: '0',
  PROVER_QUEUE_TIMEOUT_MS: '30000',
  PROVER_MANIFEST_PATH: '/app/artifacts/manifest.json',
  PROVER_WASM_PATH: '/app/artifacts/payment.wasm',
  PROVER_ZKEY_PATH: '/app/artifacts/payment.zkey',
};

describe('loadConfig', () => {
  it('ortamı ayrıştırır', () => {
    const config = loadConfig(ENV);
    expect(config).toEqual({
      port: 8080,
      metricsPort: 9464,
      corsOrigins: ['https://app.example.org', 'https://admin.example.org'],
      apiKeySha256: [sha('birinci anahtar'), sha('ikinci anahtar')],
      limits: { maxConcurrent: 2, maxQueue: 0, queueTimeoutMs: 30_000 },
      artifacts: {
        manifestPath: '/app/artifacts/manifest.json',
        wasmPath: '/app/artifacts/payment.wasm',
        zkeyPath: '/app/artifacts/payment.zkey',
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('eksik ya da geçersiz her değeri tek hatada listeler', () => {
    const env = {
      ...ENV,
      PROVER_SERVICE_PORT: '70000',
      PROVER_METRICS_PORT: undefined,
      CORS_ORIGINS: 'origin-degil',
      PROVER_API_KEY_SHA256: 'ABC',
      PROVER_MAX_CONCURRENT: '0',
      PROVER_QUEUE_TIMEOUT_MS: '1.5',
      PROVER_ZKEY_PATH: '  ',
    };
    const message = (() => {
      try {
        loadConfig(env);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    for (const key of [
      'PROVER_SERVICE_PORT',
      'PROVER_METRICS_PORT',
      'CORS_ORIGINS',
      'PROVER_API_KEY_SHA256',
      'PROVER_MAX_CONCURRENT',
      'PROVER_QUEUE_TIMEOUT_MS',
      'PROVER_ZKEY_PATH',
    ]) {
      expect(message).toContain(key);
    }
  });

  it('metrik portu servis portuyla aynı olamaz', () => {
    expect(() => loadConfig({ ...ENV, PROVER_METRICS_PORT: '8080' })).toThrow(/PROVER_METRICS_PORT/);
  });
});

describe('apiKeyCheck', () => {
  const check = apiKeyCheck([sha('birinci anahtar'), sha('ikinci anahtar')]);
  it('kayıtlı anahtarları kabul eder, diğerlerini reddeder', () => {
    expect(check('birinci anahtar')).toBe(true);
    expect(check('ikinci anahtar')).toBe(true);
    expect(check('üçüncü anahtar')).toBe(false);
    expect(check('')).toBe(false);
    expect(check(undefined)).toBe(false);
  });
});
