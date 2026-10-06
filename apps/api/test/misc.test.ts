// Prover vekili, health / ready, OpenAPI yayını, bilinmeyen yol, gövde hataları, CORS ve veritabanı kesintisi.
import { readFileSync } from 'node:fs';
import { API_OPERATIONS } from '@squaresdk/solana-sdk';
import type { ProveRequest } from '@squaresdk/solana-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadOpenApi } from '../src/openapi.js';
import { apiKey, login } from './fixtures/login.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { wallet } from './fixtures/world.js';

let stack: Stack;
const service = wallet();

beforeAll(async () => {
  stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL) });
  await truncate(stack.db);
});
afterAll(() => stack.close());
beforeEach(() => {
  stack.rpc.reset();
  stack.prover.respond = null;
});

const PROOF = {
  artifactVersion: 'aa'.repeat(32),
  proofA: '11'.repeat(64),
  proofB: '22'.repeat(128),
  proofC: '33'.repeat(64),
  publicInputs: Array.from({ length: 13 }, (_, i) => i.toString(16).padStart(64, '0')),
  provingMs: 2_100,
};
const REQUEST: ProveRequest = {
  circuit: 'payment-compliance',
  artifactVersion: 'aa'.repeat(32),
  witness: { amount: '5' },
};
const envelope = (body: unknown) => JSON.stringify(body);

describe('prover vekili', () => {
  it('prove kapsamlı anahtarla prover’a servis anahtarıyla gider; yanıt sözleşmeye göre döner', async () => {
    const key = await apiKey(stack, service, ['prove']);
    const api = stack.api({ apiKey: key });
    stack.prover.respond = { status: 200, body: envelope({ success: true, data: PROOF, error: null, meta: {} }) };
    expect(await api.prove(REQUEST)).toMatchObject({ success: true, data: PROOF });
    const forwarded = stack.prover.requests.at(-1)!;
    expect(forwarded.headers['x-api-key']).toBe('prover-service-key');
    expect(JSON.parse(forwarded.body)).toEqual(REQUEST);

    stack.prover.respond = {
      status: 409,
      body: envelope({
        success: false,
        data: null,
        error: { code: 'conflict', message: 'zkey farklı', details: { expected: 'bb'.repeat(32) } },
      }),
    };
    expect(await api.prove(REQUEST)).toMatchObject({
      error: { code: 'conflict', message: 'zkey farklı', details: { expected: 'bb'.repeat(32) } },
    });
    stack.prover.respond = {
      status: 400,
      body: envelope({ success: false, error: { code: 'invalid_input', message: 'witness' } }),
    };
    expect(await api.prove(REQUEST)).toMatchObject({ error: { code: 'invalid_input', message: 'witness' } });
    stack.prover.respond = {
      status: 503,
      body: envelope({ success: false, error: { code: 'prover_unavailable', message: 'dolu' } }),
    };
    expect(await api.prove(REQUEST)).toMatchObject({ error: { code: 'prover_unavailable' } });
    stack.prover.respond = { status: 200, body: envelope({ success: true, data: { proofA: 'x' } }) };
    expect(await api.prove(REQUEST)).toMatchObject({ error: { code: 'prover_unavailable' } });
    stack.prover.respond = { status: 502, body: '<html>bad gateway</html>' };
    expect(await api.prove(REQUEST)).toMatchObject({ error: { code: 'prover_unavailable' } });
    stack.prover.respond = null;
    expect(await api.prove(REQUEST)).toMatchObject({ error: { code: 'prover_unavailable' } });
    expect(await api.prove({ ...REQUEST, circuit: 'other' } as never)).toMatchObject({
      error: { code: 'invalid_input' },
    });
  });

  it('kimliksiz, oturumla ve kapsamsız anahtarla ispat istenemez', async () => {
    expect(await stack.api().prove(REQUEST)).toMatchObject({ error: { code: 'unauthorized' } });
    const session = await login(stack.api(), service);
    expect(await stack.api({ session }).prove(REQUEST)).toMatchObject({ error: { code: 'unauthorized' } });
    const readKey = await apiKey(stack, service, ['read']);
    expect(await stack.api({ apiKey: readKey }).prove(REQUEST)).toMatchObject({ error: { code: 'forbidden' } });
  });
});

describe('servis uçları', () => {
  it('health ve ready; bağımlılık düşünce ready 503', async () => {
    const api = stack.api();
    expect(await api.getHealth()).toMatchObject({ status: 'ok', checks: {} });
    expect(await api.getReady()).toMatchObject({ status: 'ok', checks: { database: 'ok', rpc: 'ok', storage: 'ok' } });
    stack.rpc.failWith = 500;
    expect(await api.getReady()).toMatchObject({ status: 'degraded', checks: { rpc: 'fail' } });
  });

  it('OpenAPI belgesi yayımlanıyor: sözleşmenin 33 operasyonu, sunucu adresi, dış referans yok', async () => {
    const response = await fetch(`${stack.url}/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      openapi: string;
      info: { version: string };
      servers: unknown;
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(document.servers).toEqual([{ url: PUBLIC_BASE_URL }]);
    const operations = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).flatMap((operation) => (operation.operationId ? [operation.operationId] : [])),
    );
    expect(operations.sort()).toEqual([...API_OPERATIONS].sort());
    expect(JSON.stringify(document)).not.toMatch(/"\$ref":"(?!#)/);
    const source = readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
    expect(source).toContain(`version: ${document.info.version}`);
  });

  it('bilinmeyen yol, bozuk ve büyük gövde zarfla döner; CORS izinli origin’e açık', async () => {
    const missing = await fetch(`${stack.url}/v1/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      success: false,
      error: { code: 'not_found' },
      meta: { requestId: expect.any(String) },
    });
    const broken = await fetch(`${stack.url}/v1/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"wallet":',
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: 'invalid_input' } });
    const large = await fetch(`${stack.url}/v1/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: 'x'.repeat(70_000) }),
    });
    expect(large.status).toBe(413);
    const preflight = await fetch(`${stack.url}/v1/jobs`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.square.test', 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.square.test');
    const foreign = await fetch(`${stack.url}/v1/jobs`, { headers: { origin: 'https://evil.example.com' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    expect(foreign.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('veritabanına ulaşılamazsa 503 db_unavailable ve hata alarm penceresine sayılır', async () => {
    const down = await startStack({
      openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
      databaseUrl: 'postgres://square@127.0.0.1:1/square',
    });
    try {
      expect(await down.api().listJobs()).toMatchObject({ error: { code: 'db_unavailable' } });
      expect(down.errors.count()).toBe(1);
    } finally {
      await down.close();
    }
  });
});

describe('metrikler, program kimlikleri, paket bilgisi', () => {
  it('metrik uygulaması Prometheus metinini verir, başka yol 404', async () => {
    const { createMetricsApp } = await import('../src/app.js');
    const { createLogger, createServiceMetrics } = await import('@squaresdk/solana-observability');
    const metrics = createServiceMetrics({ service: 'api-test', version: '0' });
    const server = createMetricsApp(metrics.registry, createLogger({ service: 'api-test', level: 'error' })).listen(
      0,
      '127.0.0.1',
    );
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await response.text()).toContain('square_build_info');
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('programs tablosu: dört program ve aynı IDL sürümü olmalı', async () => {
    const { loadProgramIds } = await import('../src/programs.js');
    const { SQUARE_IDLS } = await import('@squaresdk/solana-sdk');
    const { PROGRAM_IDS } = await import('./fixtures/stack.js');
    await expect(loadProgramIds(stack.db)).rejects.toThrow(/programs tablosunda yok/);
    await stack.db.program.createMany({
      data: (['registry', 'policy', 'verifier', 'escrow'] as const).map((name) => ({
        name,
        programId: PROGRAM_IDS[name].toBase58(),
        idlVersion: SQUARE_IDLS[name].metadata.version,
      })),
    });
    expect((await loadProgramIds(stack.db)).escrow.equals(PROGRAM_IDS.escrow)).toBe(true);
    await stack.db.program.update({ where: { name: 'policy' }, data: { idlVersion: '9.9.9' } });
    await expect(loadProgramIds(stack.db)).rejects.toThrow(/policy: IDL sürümü 9\.9\.9/);
  });

  it('paket bilgisi', async () => {
    const { packageInfo, parsePackageInfo } = await import('../src/package-info.js');
    expect(packageInfo.name).toBe('@squaresdk/solana-api');
    expect(() => parsePackageInfo({ name: 1 })).toThrow(/ad ve sürüm/);
    expect(() => parsePackageInfo(null)).toThrow(/ad ve sürüm/);
  });
});
