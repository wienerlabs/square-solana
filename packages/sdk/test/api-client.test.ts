// REST istemcisi: istek biçimi (yol, sorgu, başlık, gövde) ve yanıt türleri. Sunucu, istekleri kaydeden
// yerel bir HTTP fixture'ıdır; API'nin kendisiyle uçtan uca deneme apps/api testlerindedir.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_OPERATIONS } from '../src/api.js';
import { ApiClientError, createApiClient } from '../src/api-client.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const seen: Seen[] = [];
let respond: (req: Seen) => { status: number; body?: string } = () => ({ status: 200 });
let server: Server;
let baseUrl: string;

const meta = { requestId: 'r', page: null, limit: null, total: null };
const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ success: true, data, error: null, meta }) });
const fail = (status: number, code: string) => ({
  status,
  body: JSON.stringify({
    success: false,
    data: null,
    error: { code, message: `${code} mesajı`, programError: null, details: null },
    meta,
  }),
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(entry);
      const { status, body } = respond(entry);
      res.writeHead(status, body ? { 'content-type': 'application/json' } : {});
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const last = () => seen.at(-1)!;
const job = '11111111111111111111111111111112';

describe('createApiClient', () => {
  it('her operasyon bir metottur; sorgu, yol ve kimlik başlıkları', async () => {
    const api = createApiClient({ baseUrl, auth: { session: 'tok', apiKey: 'key' } });
    for (const operation of API_OPERATIONS) expect(typeof api[operation]).toBe('function');
    respond = () => ok([]);
    const listed = await api.listJobs({ status: 'delivered', page: 2, limit: 10, institution: undefined });
    expect(listed.success).toBe(true);
    expect(last().method).toBe('GET');
    expect(last().url).toBe('/api/v1/jobs?status=delivered&page=2&limit=10');
    expect(last().headers.authorization).toBe('Bearer tok');
    expect(last().headers['x-api-key']).toBe('key');
    await api.listPolicies({ active: false });
    expect(last().url).toBe('/api/v1/policies?active=false');
    await api.putAgentCard(job, { name: 'x' } as never, { agentId: 'research-1' });
    expect(last()).toMatchObject({ method: 'PUT', url: `/api/v1/agents/${job}/card?agentId=research-1` });
    expect(JSON.parse(last().body)).toEqual({ name: 'x' });
    expect(last().headers['content-type']).toBe('application/json');
  });

  it('bütün uçların yolları', async () => {
    const api = createApiClient({ baseUrl: `${baseUrl}/` });
    respond = () => ok({});
    const calls: [() => Promise<unknown>, string, string][] = [
      [() => api.createAuthChallenge({ wallet: job }), 'POST', '/api/v1/auth/challenge'],
      [
        () => api.createSession({ wallet: job, nonce: 'n'.repeat(16), signature: '1'.repeat(64) }),
        'POST',
        '/api/v1/auth/session',
      ],
      [() => api.listApiKeys(), 'GET', '/api/v1/api-keys'],
      [() => api.createApiKey({ label: 'ci', scopes: ['read'] }), 'POST', '/api/v1/api-keys'],
      [() => api.listX402Endpoints(), 'GET', '/api/v1/x402/endpoints'],
      [() => api.createX402Endpoint({} as never), 'POST', '/api/v1/x402/endpoints'],
      [() => api.getX402Endpoint('e/1'), 'GET', '/api/v1/x402/endpoints/e%2F1'],
      [() => api.updateX402Endpoint('e1', { enabled: false }), 'PATCH', '/api/v1/x402/endpoints/e1'],
      [() => api.getX402EndpointUsage('e1'), 'GET', '/api/v1/x402/endpoints/e1/usage'],
      [() => api.recordX402Payment('e1', {} as never), 'POST', '/api/v1/x402/endpoints/e1/payments'],
      [() => api.getJob(job), 'GET', `/api/v1/jobs/${job}`],
      [() => api.getInstitution(job), 'GET', `/api/v1/institutions/${job}`],
      [() => api.getPolicy(job), 'GET', `/api/v1/policies/${job}`],
      [
        () => api.putPolicyMeta(job, { name: 'n', description: null, labels: [], updatedAt: 1 }),
        'PUT',
        `/api/v1/policies/${job}/meta`,
      ],
      [() => api.listAgents(), 'GET', '/api/v1/agents'],
      [() => api.getAgent(job), 'GET', `/api/v1/agents/${job}`],
      [() => api.listClaims({ buyer: job }), 'GET', `/api/v1/claims?buyer=${job}`],
      [() => api.getClaim(job), 'GET', `/api/v1/claims/${job}`],
      [() => api.listDisputes(), 'GET', '/api/v1/disputes'],
      [() => api.getDispute(job), 'GET', `/api/v1/disputes/${job}`],
      [() => api.getScreening(job), 'GET', `/api/v1/screening/${job}`],
      [() => api.listEvents({ fromSlot: 5 }), 'GET', '/api/v1/events?fromSlot=5'],
      [() => api.listKeeperActions({ outcome: 'failed' }), 'GET', '/api/v1/keeper/actions?outcome=failed'],
      [() => api.putTravelRule(job, { record: {} as never }), 'PUT', `/api/v1/jobs/${job}/travel-rule`],
      [() => api.getTravelRule(job), 'GET', `/api/v1/jobs/${job}/travel-rule`],
      [
        () => api.createTravelRuleGrant(job, { grantee: job, purpose: 'karşı VASP', expiresAt: 1 }),
        'POST',
        `/api/v1/jobs/${job}/travel-rule/grants`,
      ],
      [() => api.listTravelRuleAccess(job, { page: 2 }), 'GET', `/api/v1/jobs/${job}/travel-rule/access?page=2`],
      [
        () => api.registerCctpTransfer({ sourceDomain: 0, sourceTxHash: `0x${'ab'.repeat(32)}`, job }),
        'POST',
        '/api/v1/cctp/transfers',
      ],
      [
        () => api.listCctpTransfers({ job, status: 'attested' }),
        'GET',
        `/api/v1/cctp/transfers?job=${job}&status=attested`,
      ],
      [() => api.getCctpTransfer('t-1'), 'GET', '/api/v1/cctp/transfers/t-1'],
      [
        () => api.prepareCctpFundTx('t-1', { feePayer: job, computeUnitPrice: null }),
        'POST',
        '/api/v1/cctp/transfers/t-1/tx',
      ],
      [() => api.prepareTx({} as never), 'POST', '/api/v1/tx'],
      [() => api.prove({} as never), 'POST', '/api/v1/prove'],
      [() => api.getHealth(), 'GET', '/api/health'],
      [() => api.getReady(), 'GET', '/api/ready'],
      [() => api.getWellKnownAgentCard(job), 'GET', `/api/a/${job}/.well-known/agent-card.json`],
      [() => api.listDisputeEvidence(job), 'GET', `/api/v1/disputes/${job}/evidence`],
      [
        () =>
          api.prepareDisputeVote(job, { resolution: { kind: 'favorAgent' }, feePayer: null, computeUnitPrice: null }),
        'POST',
        `/api/v1/disputes/${job}/votes`,
      ],
      [() => api.getArbitrationQueue({ page: 2 }), 'GET', '/api/v1/arbitration/queue?page=2'],
      [() => api.listArbitrationWebhooks(), 'GET', '/api/v1/arbitration/webhooks'],
      [
        () => api.createArbitrationWebhook({ url: 'https://hooks.example.com/a', events: ['dispute.raised'] }),
        'POST',
        '/api/v1/arbitration/webhooks',
      ],
    ];
    for (const [call, method, url] of calls) {
      await call();
      expect([last().method, last().url]).toEqual([method, url]);
      expect(last().headers.authorization).toBeUndefined();
    }
  });

  it('teslimat multipart olarak gider', async () => {
    const api = createApiClient({ baseUrl, auth: { apiKey: 'key' } });
    respond = () => ({ ...ok({}), status: 201 });
    await api.uploadDelivery(job, new Blob(['merhaba'], { type: 'text/plain' }));
    expect(last().headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(last().body).toContain('name="file"');
    expect(last().body).toContain('merhaba');
  });

  it('dispute kanıtı multipart gider, içeriği zarfsız baytlardır; abonelik silme gövdesiz', async () => {
    const api = createApiClient({ baseUrl, auth: { session: 'tok' } });
    respond = () => ({ ...ok({}), status: 201 });
    await api.uploadDisputeEvidence(job, new Blob(['gerekçe'], { type: 'text/plain' }));
    expect(last()).toMatchObject({ method: 'POST', url: `/api/v1/jobs/${job}/dispute/evidence` });
    expect(last().headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(last().body).toContain('gerekçe');

    respond = () => ({ status: 200, body: 'ham içerik' });
    const content = await api.getDisputeEvidenceContent(job, 'a/b');
    expect(last()).toMatchObject({ method: 'GET', url: `/api/v1/disputes/${job}/evidence/a%2Fb` });
    expect(last().headers.authorization).toBe('Bearer tok');
    expect(await content.text()).toBe('ham içerik');
    expect(content.type).toBe('application/json');

    respond = () => fail(403, 'forbidden');
    await expect(api.getDisputeEvidenceContent(job, 'x')).rejects.toMatchObject({
      status: 403,
      error: { code: 'forbidden' },
    });
    respond = () => ({ status: 502, body: 'bad gateway' });
    await expect(api.getDisputeEvidenceContent(job, 'x')).rejects.toThrow(/beklenmeyen yanıt \(502\)/);

    respond = () => ({ status: 204 });
    await expect(api.deleteArbitrationWebhook('w1')).resolves.toBeUndefined();
    expect(last()).toMatchObject({ method: 'DELETE', url: '/api/v1/arbitration/webhooks/w1' });
  });

  it('hata zarfı döner; zarfsız ve gövdesiz uçların hataları ApiClientError', async () => {
    const api = createApiClient({ baseUrl });
    respond = () => fail(404, 'not_found');
    const missing = await api.getJob(job);
    expect(missing).toMatchObject({ success: false, error: { code: 'not_found' } });
    await expect(api.getWellKnownAgentCard(job)).rejects.toMatchObject({ status: 404, error: { code: 'not_found' } });
    respond = () => fail(401, 'unauthorized');
    await expect(api.deleteSession()).rejects.toMatchObject({ status: 401, error: { code: 'unauthorized' } });
    respond = () => ({ status: 204 });
    await expect(api.deleteApiKey('a/b')).resolves.toBeUndefined();
    expect(last().url).toBe('/api/v1/api-keys/a%2Fb');
    await expect(api.deleteX402Endpoint('e1')).resolves.toBeUndefined();
    expect(last()).toMatchObject({ method: 'DELETE', url: '/api/v1/x402/endpoints/e1' });
    await expect(api.deleteTravelRuleGrant(job, job)).resolves.toBeUndefined();
    expect(last()).toMatchObject({ method: 'DELETE', url: `/api/v1/jobs/${job}/travel-rule/grants/${job}` });
    respond = () => ({ status: 502, body: '<html>bad gateway</html>' });
    await expect(api.getJob(job)).rejects.toBeInstanceOf(ApiClientError);
    await expect(api.deleteSession()).rejects.toThrow(/beklenmeyen yanıt \(502\)/);
    respond = () => ({ status: 200, body: '{"status":' });
    await expect(api.getHealth()).rejects.toThrow(/beklenmeyen yanıt/);
    respond = () => ({
      status: 503,
      body: JSON.stringify({ status: 'down', version: '1', checks: { database: 'fail' } }),
    });
    expect(await api.getReady()).toMatchObject({ status: 'down' });
    expect(() => createApiClient({ baseUrl: 'ftp://x' })).toThrow(/http/);
  });
});
