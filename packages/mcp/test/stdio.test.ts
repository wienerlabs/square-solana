// Uçtan uca: derlenmiş `square-mcp` (dist/bin.js) alt süreç olarak açılır ve Claude Desktop'ın yaptığı gibi
// stdio üzerinden gerçek bir MCP istemcisiyle (havuzun `stdio` hedefi, SDK'nın StdioClientTransport'u)
// konuşulur. Square API'si ve Solana RPC yerel fixture sunucularıdır. Yazma akışı: tool imzasız tx döner,
// imzasız tx gönderimi reddedilir ve RPC'ye `sendTransaction` gitmez; istemcinin imzaladığı tx gönderilir.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpClientPool } from '../src/client/index.js';
import { FakeApi } from './helpers/fake-api.js';
import { jobView, NOW } from './helpers/fixtures.js';
import { FixtureRpc } from './helpers/rpc.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

const rpc = new FixtureRpc();
const api = new FakeApi(rpc.escrowProgramId);
let apiServer: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  await rpc.listen();
  apiServer = await api.listen();
  await rpc.setSettlement({ decimals: 6, travelRuleThreshold: 0n });
});
afterAll(async () => {
  await apiServer.close();
  await rpc.close();
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    SQUARE_API_URL: apiServer.url,
    SQUARE_NETWORK: 'localnet',
    SQUARE_TIMEOUT_MS: '3000',
    SQUARE_API_KEY: 'sqk_e2e',
    SQUARE_RPC_URL: rpc.url,
    SQUARE_ESCROW_PROGRAM_ID: rpc.escrowProgramId.toBase58(),
    ...extra,
  };
}

function stdioPool(extra: Record<string, string> = {}) {
  return new McpClientPool({
    servers: { square: { type: 'stdio', command: process.execPath, args: [BIN], env: env(extra) } },
    maxConcurrency: 4,
    toolCacheTtlMs: 60_000,
    requestTimeoutMs: 15_000,
    reconnect: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  });
}

const body = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text);

describe('square-mcp stdio', () => {
  it('okuma ve imza akışı uçtan uca', async () => {
    const pool = stdioPool();
    try {
      const tools = (await pool.listTools('square')).map((tool) => tool.name);
      expect(tools).toHaveLength(9);
      expect(tools).toContain('square_submit_signed_transaction');

      const job = jobView();
      api.jobs.set(job.address, job);
      const found = body(await pool.callTool('square', 'square_find_work', {}));
      expect(found.jobs.map((entry: { address: string }) => entry.address)).toContain(job.address);
      expect(api.requests.at(-1)!.apiKey).toBe('sqk_e2e');

      const institution = Keypair.generate();
      const opened = await pool.callTool('square', 'square_open_job', {
        institution: institution.publicKey.toBase58(),
        agentRecord: Keypair.generate().publicKey.toBase58(),
        spec: { title: 'e2e' },
        amount: '1000000',
        deadline: NOW + 3600,
        challengePeriod: '3600',
      });
      const prepared = body(opened);
      expect(opened.isError).toBeFalsy();
      expect(prepared).toMatchObject({ step: 'createJob', signed: false });

      const refused = await pool.callTool('square', 'square_submit_signed_transaction', {
        transaction: prepared.transaction,
      });
      expect(refused.isError).toBe(true);
      expect(body(refused).error).toBe('not_fully_signed');
      expect(rpc.methods).not.toContain('sendTransaction');

      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
      tx.sign([institution]);
      const sent = await pool.callTool('square', 'square_submit_signed_transaction', {
        transaction: Buffer.from(tx.serialize()).toString('base64'),
      });
      expect(body(sent)).toMatchObject({ status: 'confirmed', err: null });
      expect(rpc.sent).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it('yerel imzalayıcıyla sign: true imzalayıp gönderir', async () => {
    const keypair = Keypair.generate();
    const dir = await mkdtemp(join(tmpdir(), 'square-mcp-e2e-'));
    const path = join(dir, 'id.json');
    await writeFile(path, JSON.stringify(Array.from(keypair.secretKey)));
    const job = jobView({ status: 'funded', agentWallet: keypair.publicKey.toBase58() });
    api.jobs.set(job.address, job);
    const pool = stdioPool({ SQUARE_SIGNER_KEYPAIR: path });
    try {
      const before = rpc.sent.length;
      const result = body(await pool.callTool('square', 'square_accept_job', { job: job.address, sign: true }));
      expect(result).toMatchObject({ signed: true, submitted: { status: 'confirmed' } });
      expect(rpc.sent).toHaveLength(before + 1);
    } finally {
      await pool.close();
    }
  });

  it('--http Streamable HTTP açar; yerel imzalayıcıyla ve eksik ayarla açılmaz', async () => {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = String((probe.address() as { port: number }).port);
    probe.close();

    const child = spawn(process.execPath, [BIN, '--http'], {
      env: env({ SQUARE_MCP_HTTP_HOST: '127.0.0.1', SQUARE_MCP_HTTP_PORT: port }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      let log = '';
      child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
      while (!log.includes('/mcp')) await new Promise((resolve) => setTimeout(resolve, 20));
      const pool = new McpClientPool({
        servers: { square: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } },
        maxConcurrency: 1,
        toolCacheTtlMs: 1_000,
        requestTimeoutMs: 5_000,
        reconnect: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      });
      expect((await pool.listTools('square')).length).toBe(9);
      await pool.close();
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }

    const refused = spawnSync(process.execPath, [BIN, '--http'], {
      env: env({ SQUARE_SIGNER_KEYPAIR: '/k.json', SQUARE_MCP_HTTP_HOST: '127.0.0.1', SQUARE_MCP_HTTP_PORT: port }),
      encoding: 'utf8',
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/yalnızca stdio/);
    const missing = spawnSync(process.execPath, [BIN], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/SQUARE_API_URL/);
    const unknown = spawnSync(process.execPath, [BIN, '--nope'], { env: env(), encoding: 'utf8' });
    expect(unknown.stderr).toMatch(/bilinmeyen argüman/);
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stderr).toMatch(/square-mcp \[--http\]/);
  });
});
