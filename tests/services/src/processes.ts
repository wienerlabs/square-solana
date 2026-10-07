import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { HttpPorts, ServiceEnv } from './env.js';
import { sleep } from './wait.js';

export interface ServiceProcess {
  readonly name: string;
  readonly url: string;
  readonly metricsUrl: string;
  readonly logPath: string;
  exitCode(): number | null;
  closed(): Promise<void>;
  stop(): Promise<void>;
}

export function baseEnv(env: NodeJS.ProcessEnv = process.env): ServiceEnv {
  return Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]!]])),
  );
}

export function stopChild(child: ChildProcess, graceMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    child.kill('SIGTERM');
  });
}

export function startService(params: {
  name: string;
  command: string;
  args: readonly string[];
  env: ServiceEnv;
  ports: HttpPorts;
  logDir: string;
}): ServiceProcess {
  const logPath = join(params.logDir, `${params.name}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(params.command, [...params.args], {
    env: { ...baseEnv(), ...params.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once('error', (error) => log.write(`süreç hatası: ${error.message}\n`));
  const closed = new Promise<void>((resolve) => child.once('close', () => log.end(() => resolve())));
  return {
    name: params.name,
    url: `http://127.0.0.1:${params.ports.port}`,
    metricsUrl: `http://127.0.0.1:${params.ports.metricsPort}`,
    logPath,
    exitCode: () => child.exitCode ?? (child.signalCode === null ? null : -1),
    closed: () => closed,
    stop: async () => {
      await stopChild(child);
      await closed;
    },
  };
}

export function logTail(path: string, lines = 30): string {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(günlük yok)';
  }
}

async function exitError(service: ServiceProcess, code: number, when: string): Promise<Error> {
  await service.closed();
  return new Error(
    `${service.name} ${when} çıktı (kod ${code}); günlük ${service.logPath}:\n${logTail(service.logPath)}`,
  );
}

export async function assertRunning(services: Iterable<ServiceProcess>): Promise<void> {
  for (const service of [...services]) {
    const code = service.exitCode();
    if (code !== null) throw await exitError(service, code, 'koşu sırasında');
  }
}

export async function waitReady(service: ServiceProcess, timeoutMs: number, path = '/ready'): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last: string;
  for (;;) {
    const code = service.exitCode();
    if (code !== null) throw await exitError(service, code, 'açılırken');
    try {
      const response = await fetch(`${service.url}${path}`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`;
    } catch (error) {
      last = (error as Error).message;
    }
    if (Date.now() > end) {
      throw new Error(
        `${service.name} hazır olmadı (${last}); günlük ${service.logPath}:\n${logTail(service.logPath)}`,
      );
    }
    await sleep(250);
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

export async function freePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

export async function allocatePorts(count: number): Promise<HttpPorts[]> {
  const ports = await freePorts(count * 2);
  return Array.from({ length: count }, (_, index) => ({ port: ports[index * 2]!, metricsPort: ports[index * 2 + 1]! }));
}
