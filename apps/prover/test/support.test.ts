import { readFileSync } from 'node:fs';
import { Gauge, Registry } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetricsApp } from '../src/app.js';
import { errorMessage, errorSummary } from '../src/errors.js';
import { processLog, type Log, type LogFields } from '../src/log.js';
import { packageInfo, parsePackageInfo } from '../src/package-info.js';
import { close, listen } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processLog', () => {
  it('olayları stdout’a, hataları stderr’e tek satır JSON yazar', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    processLog.event('listening', { port: 8080 });
    processLog.error('startup_failed');
    const event = JSON.parse(String(stdout.mock.calls[0]![0]));
    expect(event).toMatchObject({ event: 'listening', port: 8080 });
    expect(Date.parse(event.time)).not.toBeNaN();
    expect(JSON.parse(String(stderr.mock.calls[0]![0]))).toMatchObject({ event: 'startup_failed' });
  });
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
    const lines: { name: string; fields: LogFields }[] = [];
    const log: Log = { event: () => undefined, error: (name, fields = {}) => lines.push({ name, fields }) };
    const { server, url } = await listen(createMetricsApp(registry, log));
    try {
      expect((await fetch(`${url}/metrics`)).status).toBe(500);
      expect(lines).toEqual([{ name: 'metrics_failed', fields: { error: 'Error: kaynak okunamadı' } }]);
    } finally {
      await close(server);
    }
  });
});
