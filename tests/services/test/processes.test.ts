import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allocatePorts,
  assertRunning,
  baseEnv,
  freePorts,
  logTail,
  startService,
  stopChild,
  waitReady,
} from '../src/processes.js';
import { until } from '../src/wait.js';

const dir = mkdtempSync(join(tmpdir(), 'square-services-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function printed(child: ChildProcess, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.split('\n').includes(line)) resolve();
    });
    child.once('exit', (code) => reject(new Error(`süreç "${line}" satırını yazmadan çıktı (kod ${code})`)));
  });
}

const SERVER = `
const http = require('node:http');
const readyAt = Date.now() + Number(process.env.READY_AFTER_MS ?? 0);
http
  .createServer((req, res) => {
    if (req.url === '/exit') {
      res.end('', () => process.stderr.write('beklenmedik hata\\n', () => process.exit(4)));
      return;
    }
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

  it('koşu sırasında çıkan servis bekleme döngüsünü günlüğüyle hemen düşürür', async () => {
    const [ports] = await allocatePorts(1);
    const service = startService({
      name: 'olen',
      command: process.execPath,
      args: ['-e', SERVER],
      env: { SERVICE_PORT: String(ports!.port) },
      ports: ports!,
      logDir: dir,
    });
    try {
      await waitReady(service, 10_000);
      await expect(assertRunning([service])).resolves.toBeUndefined();
      const started = Date.now();
      await fetch(`${service.url}/exit`);
      await expect(
        until('hiç gelmeyecek değer', 120_000, async () => null, {
          intervalMs: 20,
          guard: () => assertRunning([service]),
        }),
      ).rejects.toThrow(/olen koşu sırasında çıktı \(kod 4\); günlük .*olen\.log:\n[\s\S]*beklenmedik hata/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await service.stop();
    }
  });

  it('SIGTERM yok sayılırsa süre sonunda SIGKILL', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('SIGTERM yok sayılıyor'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await printed(child, 'SIGTERM yok sayılıyor');
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
