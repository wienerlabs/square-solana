import { readFileSync } from 'node:fs';
import { Gauge, Registry, createLogger, type LogRecord } from '@squaresdk/solana-observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetricsApp } from '../src/app.js';
import { errorMessage, errorSummary } from '../src/errors.js';
import { packageInfo, parsePackageInfo } from '../src/package-info.js';
import { close, listen } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('packageInfo', () => {
  it('package.json’daki ad ve sürüm', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(packageInfo).toEqual({ name: pkg.name, version: pkg.version });
    expect(() => parsePackageInfo({ name: 'x' })).toThrow(/ad ve sürüm/);
    expect(() => parsePackageInfo(null)).toThrow(/ad ve sürüm/);
  });
});

describe('errors', () => {
  it('Error ve Error olmayan değerler', () => {
    expect(errorMessage(new TypeError('bozuk'))).toBe('bozuk');
    expect(errorMessage('düz metin')).toBe('düz metin');
    expect(errorSummary(new TypeError('bozuk'))).toBe('TypeError: bozuk');
    expect(errorSummary(42)).toBe('42');
  });
});

describe('createMetricsApp', () => {
  it('metrik toplanamazsa 500 ve hata log’u', async () => {
    const registry = new Registry();
    new Gauge({
      name: 'failing_gauge',
      help: 'toplama hatası',
      registers: [registry],
      collect() {
        throw new Error('kaynak okunamadı');
      },
    });
    const lines: LogRecord[] = [];
    const log = createLogger({
      service: 'prover-test',
      level: 'error',
      sink: { out: () => undefined, err: () => undefined },
      observers: [(record) => lines.push(record)],
    });
    const { server, url } = await listen(createMetricsApp(registry, log));
    try {
      expect((await fetch(`${url}/metrics`)).status).toBe(500);
      expect(lines).toEqual([expect.objectContaining({ msg: 'metrics_failed', error: 'Error: kaynak okunamadı' })]);
    } finally {
      await close(server);
    }
  });
});
