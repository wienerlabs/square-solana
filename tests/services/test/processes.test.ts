import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allocatePorts, baseEnv, freePorts, logTail, startService, stopChild, waitReady } from '../src/processes.js';

const dir = mkdtempSync(join(tmpdir(), 'square-services-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SERVER = `
const http = require('node:http');
const readyAt = Date.now() + Number(process.env.READY_AFTER_MS ?? 0);
http
  .createServer((req, res) => {
    res.statusCode = req.url === '/ready' ? (Date.now() >= readyAt ? 200 : 503) : 404;
    res.end(String(res.statusCode));
  })
  .listen(Number(process.env.SERVICE_PORT), '127.0.0.1', () => console.log('dinliyor ' + process.env.SERVICE_PORT));
process.on('SIGTERM', () => {
  console.error('durduruluyor');
  process.exit(0);
});
`;

describe('servis süreçleri', () => {
  it('hazır olana kadar bekler, çıktıyı günlüğe yazar ve SIGTERM ile durdurur', async () => {
    const [ports] = await allocatePorts(1);
    const service = startService({
      name: 'hazir',
      command: process.execPath,
      args: ['-e', SERVER],
      env: { SERVICE_PORT: String(ports!.port), READY_AFTER_MS: '400' },
      ports: ports!,
      logDir: dir,
    });
    await waitReady(service, 10_000);
    expect(service.url).toBe(`http://127.0.0.1:${ports!.port}`);
    expect(service.metricsUrl).toBe(`http://127.0.0.1:${ports!.metricsPort}`);
    expect(service.exitCode()).toBeNull();
    await service.stop();
    expect(service.exitCode()).toBe(0);
    expect(logTail(service.logPath)).toBe(`dinliyor ${ports!.port}\ndurduruluyor`);
    await service.stop();
  });

  it('açılışta çıkan süreç günlüğüyle hemen hata verir', async () => {
    const [ports] = await allocatePorts(1);
    const service = startService({
      name: 'dusen',
      command: process.execPath,
      args: ['-e', "console.error('Geçersiz ortam: X_EKSIK'); process.exit(3)"],
      env: {},
      ports: ports!,
      logDir: dir,
    });
    await expect(waitReady(service, 30_000)).rejects.toThrow(/dusen açılırken çıktı \(kod 3\)[\s\S]*X_EKSIK/);
  });

  it('süresinde hazır olmayan süreç son yanıtla hata verir', async () => {
    const [ports] = await allocatePorts(1);
    const service = startService({
      name: 'hazir-degil',
      command: process.execPath,
      args: ['-e', SERVER],
      env: { SERVICE_PORT: String(ports!.port), READY_AFTER_MS: '600000' },
      ports: ports!,
      logDir: dir,
    });
    try {
      await expect(waitReady(service, 1_500)).rejects.toThrow(/hazir-degil hazır olmadı \(HTTP 503: 503\)/);
    } finally {
      await service.stop();
    }
  });

  it('SIGTERM yok sayılırsa süre sonunda SIGKILL', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stopChild(child, 200);
    expect(child.signalCode).toBe('SIGKILL');
    await stopChild(child);
  });

  it('serbest portlar tekil; ortam yalnızca temel değişkenleri taşır; günlük yoksa belirtilir', async () => {
    const ports = await freePorts(6);
    expect(new Set(ports).size).toBe(6);
    expect(baseEnv({ PATH: '/bin', HOME: '/home/x', DATABASE_URL: 'postgres://gizli', VITEST: 'true' })).toEqual({
      PATH: '/bin',
      HOME: '/home/x',
    });
    expect(logTail(join(dir, 'yok.log'))).toBe('(günlük yok)');
  });
});
