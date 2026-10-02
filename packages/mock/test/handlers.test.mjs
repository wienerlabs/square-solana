// MSW handler'ları: yol tablosu OpenAPI ile birebir; istekler gerçek fetch ile mock'a ulaşır,
// HTTP durumları ve gövdeler sözleşmeye uyar.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import * as T from '@squaresdk/solana-types';
import { MOCK_IDS, MOCK_ROUTES, ROLES, createMockApi, mockAddress, mockSignature } from '../dist/index.js';
import { setupMockServer } from '../dist/node.js';

const spec = parse(readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8'));
const BASE = 'http://localhost:3000';
const api = createMockApi();
const server = setupMockServer(api, { baseUrl: BASE });

before(() => server.listen({ onUnhandledRequest: 'error' }));
after(() => server.close());

const get = (path) => fetch(BASE + path);
const send = (method, path, body) =>
  fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('handler tablosu OpenAPI yollarıyla birebir aynı', () => {
  const fromSpec = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([, op]) => op && typeof op === 'object' && 'operationId' in op)
      .map(([method, op]) => `${method} ${path} ${op.operationId}`),
  );
  const fromMock = MOCK_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`);
  assert.deepEqual([...fromMock].sort(), [...fromSpec].sort());
});

test('okuma uçları: 200 + şemaya uyan zarf, sayfalama meta\'sı', async () => {
  api.scenario.setVariant('happy');
  api.scenario.goTo(8);
  const res = await get('/v1/jobs?page=1&limit=10');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(T.envelopeSchema(T.JobViewSchema.array()).safeParse(body).success);
  assert.deepEqual([body.meta.page, body.meta.limit, body.meta.total], [1, 10, 1]);

  const job = await (await get(`/v1/jobs/${MOCK_IDS.job}`)).json();
  assert.ok(T.envelopeSchema(T.JobViewSchema).safeParse(job).success);
  const events = await (await get(`/v1/events?job=${MOCK_IDS.job}&program=escrow`)).json();
  assert.ok(events.data.length > 0 && events.data.every((e) => e.payload.program === 'escrow'));
});

test('hatalar: 404, 400 ve geçersiz sorgu', async () => {
  const missing = await get(`/v1/jobs/${mockAddress('yok')}`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'not_found');
  assert.equal((await get('/v1/jobs?limit=500')).status, 400);
  assert.equal((await get('/v1/policies?active=belki')).status, 400);
  const badJson = await send('POST', '/v1/tx', '{bozuk');
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'invalid_input');
});

test('prepareTx: screening reddi 422 + program hatası', async () => {
  api.scenario.setVariant('screeningFlagged');
  api.scenario.goTo(3);
  const res = await send('POST', '/v1/tx', {
    call: { program: 'escrow', instruction: 'fundJob', args: {} },
    accounts: { institution: ROLES.institution.wallet, institutionTokenAccount: mockAddress('ata:institution') },
    feePayer: ROLES.institution.wallet,
    computeUnitPrice: null,
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, 'program_error');
  assert.equal(body.error.programError.name, 'ScreeningFlagged');
  api.scenario.setVariant('happy');
});

test('yazma uçları: 201 / 204 ve silinmiş anahtarda 404', async () => {
  const created = await send('POST', '/v1/api-keys', { label: 'ci', scopes: ['read'] });
  assert.equal(created.status, 201);
  const { data } = await created.json();
  assert.equal((await fetch(`${BASE}/v1/api-keys/${data.apiKey.id}`, { method: 'DELETE' })).status, 204);
  const again = await fetch(`${BASE}/v1/api-keys/${data.apiKey.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
  assert.equal((await again.json()).error.code, 'not_found');
  assert.equal((await fetch(`${BASE}/v1/auth/session`, { method: 'DELETE' })).status, 204);
});

test('cüzdan oturumu: challenge → session, nonce tekrar kullanılamaz', async () => {
  const wallet = ROLES.agent.wallet;
  const challenge = await (await send('POST', '/v1/auth/challenge', { wallet })).json();
  const request = { wallet, nonce: challenge.data.nonce, signature: mockSignature('login') };
  const session = await send('POST', '/v1/auth/session', request);
  assert.equal(session.status, 200);
  assert.ok(T.envelopeSchema(T.SessionSchema).safeParse(await session.json()).success);
  assert.equal((await send('POST', '/v1/auth/session', request)).status, 401);
});

test('teslimat yükleme: multipart dosya, workHash = SHA-256', async () => {
  const content = 'rapor içeriği\n';
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), 'report.txt');
  const res = await fetch(`${BASE}/v1/jobs/${MOCK_IDS.job}/deliveries`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(T.envelopeSchema(T.DeliveryReceiptSchema).safeParse(body).success);
  assert.equal(body.data.workHash, createHash('sha256').update(content).digest('hex'));
  const empty = await fetch(`${BASE}/v1/jobs/${MOCK_IDS.job}/deliveries`, { method: 'POST', body: new FormData() });
  assert.equal(empty.status, 400);
});

test('zarfsız uçlar: well-known agent card ve health', async () => {
  const card = await get(`/a/${MOCK_IDS.agentRecord}/.well-known/agent-card.json`);
  assert.equal(card.status, 200);
  assert.ok(T.AgentCardSchema.safeParse(await card.json()).success);
  assert.equal((await get(`/a/${mockAddress('yok')}/.well-known/agent-card.json`)).status, 404);
  const health = await get('/health');
  assert.equal(health.status, 200);
  assert.ok(T.HealthSchema.safeParse(await health.json()).success);
});
