import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { acceptsConnections, startValidator, type LocalnetProgramIds, type ValidatorArgs } from '../src/localnet.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error('spawn çağrılmamalıydı');
    }),
    spawnSync: vi.fn(() => {
      throw new Error('spawnSync çağrılmamalıydı');
    }),
  };
});

const dir = mkdtempSync(join(tmpdir(), 'square-smoke-localnet-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.clearAllMocks());

const PROGRAM_IDS: LocalnetProgramIds = { registry: 'r', policy: 'p', verifier: 'v', escrow: 'e' };
const PORT_NAMES = { rpcPort: 'RPC', faucetPort: 'faucet', gossipPort: 'gossip' } as const;

function listen(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const portOf = (server: Server) => (server.address() as { port: number }).port;
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function closedPort(): Promise<number> {
  const server = await listen();
  const port = portOf(server);
  await close(server);
  return port;
}

async function validatorArgsWithClosedPorts(): Promise<ValidatorArgs> {
  return {
    deployDir: dir,
    ledger: join(dir, 'ledger'),
    rpcPort: await closedPort(),
    faucetPort: await closedPort(),
    gossipPort: await closedPort(),
    dynamicPortRange: '28100-28200',
  };
}

const start = (args: ValidatorArgs, logPath: string) =>
  startValidator({ args, programIds: PROGRAM_IDS, upgradeAuthority: Keypair.generate().publicKey, logPath });

describe('validator portları', () => {
  it('dinlenen port bağlantı kabul eder, kapalı port etmez', async () => {
    const server = await listen();
    try {
      expect(await acceptsConnections(portOf(server))).toBe(true);
    } finally {
      await close(server);
    }
    expect(await acceptsConnections(await closedPort())).toBe(false);
  });

  it.each(Object.keys(PORT_NAMES) as (keyof typeof PORT_NAMES)[])(
    '%s başka bir süreçte açıksa validator süreci açılmadan hata verilir',
    async (busy) => {
      const server = await listen();
      try {
        const args = await validatorArgsWithClosedPorts();
        args[busy] = portOf(server);
        const logPath = join(dir, `${busy}.log`);
        await expect(start(args, logPath)).rejects.toThrow(
          `validator başlatılmadı: ${PORT_NAMES[busy]} portu ${portOf(server)} zaten bağlantı kabul ediyor`,
        );
        expect(spawnSync).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
        expect(existsSync(logPath)).toBe(false);
      } finally {
        await close(server);
      }
    },
  );

  it('portlar boşsa denetim geçer ve sıra Agave sürümünün sorulmasına gelir', async () => {
    await expect(start(await validatorArgsWithClosedPorts(), join(dir, 'bos.log'))).rejects.toThrow(
      'spawnSync çağrılmamalıydı',
    );
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });
});
