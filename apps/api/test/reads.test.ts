// Okuma uçları: indexer tablolarından sözleşme görünümleri, zarf ve sayfa meta verisi, filtreler, 404 ve
// geçersiz sorgu; anahtarla okuma `read` kapsamı ister.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadOpenApi } from '../src/openapi.js';
import { apiKey } from './fixtures/login.js';
import { CHAIN_REF, PROGRAM_IDS, PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { World, wallet } from './fixtures/world.js';

let stack: Stack;
const owner = wallet();
const agentWallet = wallet();
let ids: { institution: string; policy: string; agent: string; job: string; disputed: string };

beforeAll(async () => {
  stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL) });
  await truncate(stack.db);
  const world = new World(stack.db, stack.rpc, stack.client);
  const institution = await world.institution(owner.address);
  const policy = await world.policy(institution);
  const agent = await world.agent(owner.address, agentWallet.address);
  await world.screening(agentWallet.address, 4_000_000_000);
  const job = await world.job({ institution, agentRecord: agent, agentWallet: agentWallet.address });
  const disputed = await world.job({
    institution,
    agentRecord: agent,
    agentWallet: agentWallet.address,
    disputed: true,
  });
  await world.claim(job.address, agentWallet.address);
  await world.event(job.address);
  await world.keeperAction(job.address, 'skipped');
  await world.keeperAction(job.address, 'confirmed');
  ids = { institution, policy, agent, job: job.address, disputed: disputed.address };
});
afterAll(() => stack.close());

describe('okuma uçları', () => {
  it('job listesi ve tek job; sayfa meta verisi', async () => {
    const api = stack.api();
    const page = await api.listJobs({ institution: ids.institution, page: 1, limit: 1 });
    if (!page.success) throw new Error(page.error.message);
    expect(page.meta).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(page.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await api.listJobs({ status: 'disputed' })).data?.map((j) => j.address)).toEqual([ids.disputed]);
    const job = await api.getJob(ids.job);
    expect(job.success && job.data).toMatchObject({ address: ids.job, payee: agentWallet.address });
    expect(job.success && job.data.claim?.status).toBe('listed');
    expect(job.meta).toMatchObject({ page: null, limit: null, total: null });
  });

  it('kurum, politika, agent, alacak, dispute, screening, event ve keeper günlüğü', async () => {
    const api = stack.api();
    expect((await api.getInstitution(ids.institution)).data?.account.name).toBe('Example Research Ltd');
    expect((await api.listPolicies({ institution: ids.institution, active: true })).meta.total).toBe(1);
    expect((await api.getPolicy(ids.policy)).data?.meta).toBeNull();
    const agents = await api.listAgents({ owner: owner.address, status: 'active' });
    expect(agents.data?.map((a) => a.address)).toEqual([ids.agent]);
    const agent = await api.getAgent(ids.agent);
    expect(agent.data?.did).toBe(`did:aip:solana:${CHAIN_REF}:${PROGRAM_IDS.registry.toBase58()}:${ids.agent}`);
    expect((await api.listClaims({ seller: agentWallet.address, status: 'listed' })).meta.total).toBe(1);
    expect((await api.getClaim(ids.job)).data?.job).toBe(ids.job);
    expect((await api.listDisputes({ jobStatus: 'disputed' })).data?.map((d) => d.job)).toEqual([ids.disputed]);
    expect((await api.getDispute(ids.disputed)).data?.dispute.raisedAt).toBe(1_790_000_500);
    expect((await api.getScreening(agentWallet.address)).data?.fresh).toBe(true);
    const events = await api.listEvents({ job: ids.job, program: 'escrow', name: 'JobFunded', fromSlot: 0 });
    expect(events.data?.map((e) => e.payload.name)).toEqual(['JobFunded']);
    const actions = await api.listKeeperActions({ job: ids.job });
    expect(actions.data?.map((a) => [a.outcome, a.reason, a.keeperFee])).toEqual(
      expect.arrayContaining([
        ['skipped', 'challengeOpen', null],
        ['confirmed', null, '2500'],
      ]),
    );
    expect((await api.listKeeperActions({ outcome: 'skipped' })).data?.[0]?.nextAttemptAt).toBe(
      Date.parse('2026-10-07T00:00:00Z') / 1000,
    );
  });

  it('bulunamayan kaynak 404, geçersiz yol ve sorgu 400', async () => {
    const api = stack.api();
    const missing = owner.address;
    const notFound = await Promise.all([
      api.getJob(missing),
      api.getInstitution(missing),
      api.getPolicy(missing),
      api.getAgent(missing),
      api.getClaim(missing),
      api.getDispute(missing),
      api.getScreening(owner.address),
    ]);
    expect(notFound.map((r) => r.success || r.error.code)).toEqual(Array(7).fill('not_found'));
    expect(await api.getJob('nope')).toMatchObject({ error: { code: 'invalid_input' } });
    expect(await api.listJobs({ status: 'lost' as never })).toMatchObject({ error: { code: 'invalid_input' } });
    expect(await api.listJobs({ limit: 201 })).toMatchObject({ error: { code: 'invalid_input' } });
    const unknownQuery = await fetch(`${stack.url}/v1/jobs?colour=red`);
    expect(unknownQuery.status).toBe(400);
    const badBoolean = await fetch(`${stack.url}/v1/policies?active=yes`);
    expect(badBoolean.status).toBe(400);
  });

  it('anahtarla okuma read kapsamı ister', async () => {
    const withRead = await apiKey(stack, wallet(), ['read']);
    const withoutRead = await apiKey(stack, wallet(), ['tx:prepare']);
    expect((await stack.api({ apiKey: withRead }).getJob(ids.job)).success).toBe(true);
    expect(await stack.api({ apiKey: withoutRead }).getJob(ids.job)).toMatchObject({ error: { code: 'forbidden' } });
    expect(await stack.api({ apiKey: withoutRead }).listKeeperActions()).toMatchObject({
      error: { code: 'forbidden' },
    });
  });
});
