import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { HealthSchema, ProveResponseSchema, envelopeSchema } from '@squaresdk/solana-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createMetricsApp } from '../src/app.js';
import { loadArtifacts, type Artifacts } from '../src/artifacts.js';
import { apiKeyCheck } from '../src/auth.js';
import { createLimiter } from '../src/limiter.js';
import {
  createEventWindow,
  createHealth,
  createLogger,
  type EventWindow,
  type LogRecord,
} from '@squaresdk/solana-observability';
import { createMetrics, type ProverMetrics } from '../src/metrics.js';
import { createProver, type Prover } from '../src/prover.js';
import { ARTIFACT_PATHS, close, listen, scenario, verifyResponse } from './helpers.js';

const API_KEY = 'prover-test-api-key';
const INFO = { name: '@squaresdk/solana-prover', version: '0.1.0' };
const ProveEnvelope = envelopeSchema(ProveResponseSchema);

/** Hata zarfının `error` alanı. */
async function errorOf(response: Response) {
  const body = ProveEnvelope.parse(await response.json());
  if (body.success) throw new Error('hata zarfı bekleniyordu');
  return body.error;
}

/** Log kayıtlarını toplar; witness'ın log'a düşmediği buradan denetlenir. */
function collectingLog() {
  const lines: LogRecord[] = [];
  const log = createLogger({
    service: INFO.name,
    level: 'debug',
    sink: { out: () => undefined, err: () => undefined },
    observers: [(record) => lines.push(record)],
  });
  return { log, lines };
}

/** Metin biçimindeki metrikte `name` satırı; etiket sırası istemcinin işidir. */
function metricLine(text: string, name: string, labels: readonly string[]): string | undefined {
  return text.split('\n').find((line) => line.startsWith(`${name}{`) && labels.every((label) => line.includes(label)));
}

interface Service {
  url: string;
  server: Server;
  metrics: ProverMetrics;
  lines: ReturnType<typeof collectingLog>['lines'];
  failures: EventWindow;
}

async function start(prover: Prover, limits = { maxConcurrent: 2, maxQueue: 2, queueTimeoutMs: 60_000 }) {
  const limiter = createLimiter(limits);
  const metrics = createMetrics({
    service: INFO.name,
    version: INFO.version,
    artifactVersion: prover.version,
    limiter,
  });
  const { log, lines } = collectingLog();
  const failures = createEventWindow({ windowSeconds: 60 });
  const health = createHealth({
    version: INFO.version,
    checks: { capacity: () => limiter.hasCapacity() },
    timeoutMs: 1000,
    logger: log,
  });
  const app = createApp({
    info: INFO,
    corsOrigins: ['https://app.example.org'],
    checkApiKey: apiKeyCheck([createHash('sha256').update(API_KEY).digest('hex')]),
    prover,
    limiter,
    retryAfterSecs: Math.ceil(limits.queueTimeoutMs / 1000),
    metrics,
    log,
    health,
    failures,
  });
  const { server, url } = await listen(app);
  return { server, url, metrics, lines, failures } satisfies Service;
}

const post = (url: string, body: unknown, headers: Readonly<Record<string, string>> = { 'x-api-key': API_KEY }) =>
  fetch(`${url}/v1/prove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

let artifacts: Artifacts;
let service: Service;
const request = (witness = scenario('ok_compliant').witness, artifactVersion = artifacts.version) => ({
  circuit: 'payment-compliance',
  artifactVersion,
  witness,
});

beforeAll(async () => {
  artifacts = await loadArtifacts(ARTIFACT_PATHS);
  service = await start(createProver(artifacts));
});
afterAll(() => close(service.server));

describe('POST /v1/prove', () => {
  it('geçerli istekte zarflı, doğrulanan ispat döner; witness log’a düşmez', async () => {
    const witness = scenario('ok_sold_claim').witness;
    const response = await post(service.url, request(witness));
    expect(response.status).toBe(200);
    const body = ProveEnvelope.parse(await response.json());
    if (!body.success) throw new Error('başarı bekleniyordu');
    expect(body.meta.requestId).toBe(response.headers.get('x-request-id'));
    expect(body.data.artifactVersion).toBe(artifacts.version);
    expect(await verifyResponse(body.data)).toBe(true);

    const line = service.lines.find((l) => l['requestId'] === body.meta.requestId);
    expect(line).toMatchObject({ level: 'info', msg: 'prove', result: 'ok', refusalCode: 0 });
    const logged = JSON.stringify(service.lines);
    for (const value of [
      ...(witness.policy_salts as string[]),
      witness.max_daily as string,
      witness.payee_low_in as string,
    ]) {
      expect(logged).not.toContain(value);
    }
  });

  it('API anahtarı yoksa ya da yanlışsa 401', async () => {
    for (const headers of [{}, { 'x-api-key': 'yanlis-anahtar' }] as Record<string, string>[]) {
      const response = await post(service.url, request(), headers);
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe('unauthorized');
    }
  });

  it('şemaya uymayan istek 400', async () => {
    const response = await post(service.url, { circuit: 'baska-devre', artifactVersion: 'xyz', witness: { a: 1 } });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('invalid_input');
    const issues = (error.details?.['issues'] ?? []) as { path: string }[];
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['circuit', 'artifactVersion', 'witness.a']));
  });

  it('yanlış artefakt sürümünde 409 ve beklenen sürüm', async () => {
    const other = createHash('sha256').update('başka bir zkey').digest('hex');
    const response = await post(service.url, request(undefined, other));
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: 'conflict',
      details: { expected: artifacts.version, received: other },
    });
  });

  it('devreyi sağlamayan witness 400', async () => {
    const witness = { ...scenario('ok_compliant').witness, net_amount_in: (2n ** 64n).toString() };
    const response = await post(service.url, request(witness));
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toMatch(/witness devreyi sağlamıyor/);
  });

  it('bozuk JSON 400, büyük gövde 413', async () => {
    const broken = await post(service.url, '{"circuit":');
    expect(broken.status).toBe(400);
    expect((await errorOf(broken)).code).toBe('invalid_input');
    const large = await post(service.url, { ...request(), padding: 'x'.repeat(70 * 1024) });
    expect(large.status).toBe(413);
    expect((await errorOf(large)).code).toBe('invalid_input');
  });

  it('üretilen ispat doğrulanamazsa 500 ve hata log’u', async () => {
    // IC[1] ile IC[2] yer değiştirmiş anahtar: geçerli eğri noktaları, ama başka bir doğrulama anahtarı.
    const vk = artifacts.verificationKey as unknown as { IC: unknown[] };
    const swapped = { ...vk, IC: [vk.IC[0], vk.IC[2], vk.IC[1], ...vk.IC.slice(3)] };
    const broken = await start(createProver({ ...artifacts, verificationKey: swapped as never }));
    try {
      const response = await post(broken.url, request());
      expect(response.status).toBe(500);
      expect((await errorOf(response)).code).toBe('internal_error');
      expect(broken.lines).toContainEqual(
        expect.objectContaining({
          level: 'error',
          msg: 'prove_failed',
          error: expect.stringMatching(/ProofSelfCheckError/),
        }),
      );
      // `prover_failures` alarmının değeri.
      expect(broken.failures.count()).toBe(1);
    } finally {
      await close(broken.server);
    }
  });
});

describe('kapasite', () => {
  it('sınır doluyken 503 + Retry-After, /ready 503', async () => {
    const busy = await start(createProver(artifacts), { maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 30_000 });
    try {
      const first = post(busy.url, request());
      // İlk istek yuvayı alana kadar bekle.
      await expect.poll(async () => (await fetch(`${busy.url}/ready`)).status).toBe(503);
      const ready = HealthSchema.parse(await (await fetch(`${busy.url}/ready`)).json());
      expect(ready).toEqual({ status: 'down', version: INFO.version, checks: { capacity: 'fail' } });

      const second = await post(busy.url, request());
      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBe('30');
      expect((await errorOf(second)).code).toBe('prover_unavailable');
      expect((await first).status).toBe(200);
      expect((await fetch(`${busy.url}/ready`)).status).toBe(200);
    } finally {
      await close(busy.server);
    }
  });
});

interface OpenApiDoc {
  openapi: string;
  info: { description: string };
  paths: Record<
    string,
    {
      post: {
        responses: Record<string, unknown>;
        requestBody: { content: Record<string, { schema: { required: string[] } }> };
      };
    }
  >;
}

describe('health, OpenAPI, bilinmeyen yol', () => {
  it('/health ve /ready sözleşmedeki Health şemasıyla', async () => {
    const health = await fetch(`${service.url}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(HealthSchema.parse(await health.json())).toEqual({ status: 'ok', version: INFO.version, checks: {} });
    const ready = await fetch(`${service.url}/ready`);
    expect(ready.status).toBe(200);
    expect(HealthSchema.parse(await ready.json())).toEqual({
      status: 'ok',
      version: INFO.version,
      checks: { capacity: 'ok' },
    });
  });

  it('/openapi.json uç noktaları, güven sınırını ve yüklü artefakt sürümünü bildirir', async () => {
    const doc = (await (await fetch(`${service.url}/openapi.json`)).json()) as OpenApiDoc;
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(['/v1/prove', '/health', '/ready']);
    const prove = doc.paths['/v1/prove']!.post;
    expect(Object.keys(prove.responses)).toEqual(['200', '400', '401', '409', '500', '503']);
    expect(prove.requestBody.content['application/json']!.schema.required).toEqual([
      'circuit',
      'artifactVersion',
      'witness',
    ]);
    expect(doc.info.description).toContain(artifacts.version);
    expect(doc.info.description).toContain('Güven sınırı');
  });

  it('bilinmeyen yol zarflı 404', async () => {
    const response = await fetch(`${service.url}/prove`, { method: 'POST' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('not_found');
  });
});

describe('metrikler', () => {
  it('ayrı uygulamada Prometheus metinleri; ispat sonuçları ve HTTP istekleri sayılır', async () => {
    const { log } = collectingLog();
    const { server, url } = await listen(createMetricsApp(service.metrics.registry, log));
    try {
      const response = await fetch(`${url}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      const text = await response.text();
      const service_ = 'service="@squaresdk/solana-prover"';
      expect(
        metricLine(text, 'square_build_info', [`version="${INFO.version}"`, `artifact_version="${artifacts.version}"`]),
      ).toBeDefined();
      expect(metricLine(text, 'prover_proofs_total', ['result="ok"', service_])).toMatch(/ [1-9]\d*$/);
      expect(metricLine(text, 'prover_proofs_total', ['result="unauthorized"'])).toBeDefined();
      expect(metricLine(text, 'prover_proofs_total', ['result="artifact_mismatch"'])).toBeDefined();
      expect(text).toMatch(/prover_proving_seconds_count\{service="@squaresdk\/solana-prover"\} [1-9]/);
      expect(
        metricLine(text, 'http_requests_total', ['method="POST"', 'route="/v1/prove"', 'status="200"']),
      ).toBeDefined();
      expect(
        metricLine(text, 'http_requests_total', ['method="POST"', 'route="unmatched"', 'status="404"']),
      ).toBeDefined();
      expect(
        metricLine(text, 'http_request_duration_seconds_count', ['route="/v1/prove"', 'status="200"']),
      ).toBeDefined();
      expect(text).toContain('prover_active_proofs');
      expect(text).toContain('process_cpu_user_seconds_total');
      expect((await fetch(`${url}/health`)).status).toBe(404);
    } finally {
      await close(server);
    }
  });
});
