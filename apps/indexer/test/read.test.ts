// Okuma API'si: indexer'ın yazdığı tablolardan sözleşme görünümleri, filtreler ve sayfalama.
import { createHash } from 'node:crypto';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { CHAIN_REFS } from '@squaresdk/solana-identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadApi, type ReadApi } from '../src/read/index.js';
import { FixtureChain, startRpcServer, type RpcServer } from './fixtures/rpc-server.js';
import { buildScenario, type Scenario } from './fixtures/scenario.js';
import { createStack, seedPrograms } from './fixtures/stack.js';
import { PROGRAM_IDS, World } from './fixtures/world.js';

let db: IsolatedDatabase;
let server: RpcServer;
let scenario: Scenario;
let read: ReadApi;
/** Senaryodaki kurum screening'inin `expiresAt`'inden önce. */
const NOW_MS = 1_800_000_000_000;
const page = { page: 1, limit: 50 };
const a = (key: { toBase58(): string }) => key.toBase58();

const card = (agentRecord: string) => ({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Research Agent',
  description: 'Literature review agent',
  url: 'https://agents.example.com/a2a',
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    { id: 'literature-review', name: 'Literature review', description: 'Summarises papers', tags: ['research'] },
  ],
  services: [{ name: 'A2A', endpoint: 'https://agents.example.com/a2a', version: '1.0.0' }],
  registrations: [
    { agentRegistry: `solana:${CHAIN_REFS.devnet}:${PROGRAM_IDS.registry.toBase58()}`, agentId: agentRecord },
  ],
  active: true,
});

beforeAll(async () => {
  db = await startIsolatedDatabase();
  const chain = new FixtureChain();
  server = await startRpcServer(chain);
  const world = new World(chain, server.url);
  scenario = await buildScenario(world);
  await seedPrograms(db.client);
  const stack = await createStack(db.client, [server.url]);
  await stack.poller.runOnce();
  read = createReadApi({
    db: db.client,
    chainRef: CHAIN_REFS.devnet,
    registryProgramId: PROGRAM_IDS.registry,
    clock: () => NOW_MS,
  });
});
afterAll(async () => {
  await server.close();
  await db.stop();
});

describe('job görünümleri', () => {
  it('job, alacağı, release ispatı ve validation kaydıyla; ödeme alıcıya', async () => {
    const view = (await read.getJob(a(scenario.paidJob)))!;
    expect(view.address).toBe(a(scenario.paidJob));
    expect(view.account.status).toBe('released');
    expect(view.payee).toBe(a(scenario.buyer));
    expect(view.claim?.status).toBe('settled');
    expect(view.releaseProof?.job).toBe(a(scenario.paidJob));
    expect(view.validation?.outcome).toBe('verified');
    expect(view.slot).toBeGreaterThan(0);
    expect(view.indexedAt).toBeGreaterThan(1_700_000_000);
    expect(view.indexedAt).toBeLessThan(10_000_000_000);

    const disputed = (await read.getJob(a(scenario.disputedJob)))!;
    // Listelenmiş ama satılmamış alacak: ödeme agent cüzdanına.
    expect(disputed.payee).toBe(a(scenario.agentWallet));
    expect(disputed.claim?.status).toBe('listed');
    expect(disputed.releaseProof).toBeNull();
    expect(await read.getJob(a(scenario.agent))).toBeNull();
  });

  it('filtreler ve sayfalama', async () => {
    expect((await read.listJobs({}, page)).total).toBe(2);
    expect((await read.listJobs({ status: 'disputed' }, page)).items.map((j) => j.address)).toEqual([
      a(scenario.disputedJob),
    ]);
    expect(
      (await read.listJobs({ institution: a(scenario.institution), agentRecord: a(scenario.agent) }, page)).total,
    ).toBe(2);
    expect((await read.listJobs({ policy: a(scenario.policy) }, page)).total).toBe(2);
    expect((await read.listJobs({ institution: a(scenario.agent) }, page)).total).toBe(0);
    const first = await read.listJobs({}, { page: 1, limit: 1 });
    const second = await read.listJobs({}, { page: 2, limit: 1 });
    expect(first).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(new Set([first.items[0]!.address, second.items[0]!.address]).size).toBe(2);
    await expect(read.listJobs({}, { page: 0, limit: 1 })).rejects.toThrow();
    await expect(read.listJobs({}, { page: 1, limit: 201 })).rejects.toThrow();
    await expect(read.listJobs({ status: 'lost' as never }, page)).rejects.toThrow();
    await expect(read.getJob('not-an-address')).rejects.toThrow();
  });
});

describe('kurum ve politika', () => {
  it('kurum görünümü ve meta verili politika', async () => {
    expect((await read.getInstitution(a(scenario.institution)))?.account.name).toBe('Example Research Ltd');
    expect(await read.getInstitution(a(scenario.policy))).toBeNull();
    expect((await read.getPolicy(a(scenario.policy)))?.meta).toBeNull();
    await db.client.policyMeta.create({
      data: {
        policy: a(scenario.policy),
        name: 'Research spend',
        description: null,
        labels: ['research'],
        updatedBy: a(scenario.owner),
      },
    });
    const policy = (await read.getPolicy(a(scenario.policy)))!;
    expect(policy.meta).toMatchObject({ name: 'Research spend', description: null, labels: ['research'] });
    expect(policy.meta!.updatedAt).toBeLessThan(10_000_000_000);
    expect((await read.listPolicies({ institution: a(scenario.institution), active: true }, page)).total).toBe(1);
    expect((await read.listPolicies({ active: false }, page)).total).toBe(0);
    expect(await read.getPolicy(a(scenario.agent))).toBeNull();
  });
});

describe('agent', () => {
  it('DID, itibar ve doğrulanmış kart; beceriye göre liste', async () => {
    const agent = (await read.getAgent(a(scenario.agent)))!;
    expect(agent.did).toBe(`did:aip:solana:${CHAIN_REFS.devnet}:${a(PROGRAM_IDS.registry)}:${a(scenario.agent)}`);
    expect(agent.card).toBeNull();
    expect(agent.cardVerified).toBe(false);
    expect(agent.reputation?.agentRecord).toBe(a(scenario.agent));

    const CARD = card(a(scenario.agent));
    const raw = Buffer.from(JSON.stringify(CARD));
    const contentHash = createHash('sha256').update(raw).digest('hex');
    await db.client.agentCard.create({
      data: {
        agentRecord: a(scenario.agent),
        source: 'hosted',
        uri: CARD.url,
        raw,
        contentHash,
        content: CARD,
        skills: ['literature-review'],
        verified: false,
        verifiedAt: new Date(NOW_MS),
      },
    });
    // Kartın hash'i zincirdeki değer değilse doğrulanmış sayılmaz.
    const unverified = (await read.getAgent(a(scenario.agent)))!;
    expect(unverified.card?.name).toBe('Research Agent');
    expect(unverified.cardVerified).toBe(false);
    await db.client.agent.update({ where: { address: a(scenario.agent) }, data: { agentCardHash: contentHash } });
    expect((await read.getAgent(a(scenario.agent)))!.cardVerified).toBe(true);

    expect((await read.listAgents({ skill: 'literature-review' }, page)).items.map((v) => v.address)).toEqual([
      a(scenario.agent),
    ]);
    expect((await read.listAgents({ skill: 'translation' }, page)).total).toBe(0);
    expect((await read.listAgents({ owner: a(scenario.owner), status: 'active' }, page)).total).toBe(1);
    expect(await read.getAgent(a(scenario.policy))).toBeNull();
  });
});

describe('alacak, dispute, screening, event', () => {
  it('alacaklar', async () => {
    expect((await read.listClaims({}, page)).total).toBe(2);
    expect((await read.listClaims({ status: 'listed' }, page)).items.map((c) => c.job)).toEqual([
      a(scenario.disputedJob),
    ]);
    expect((await read.listClaims({ buyer: a(scenario.buyer) }, page)).total).toBe(1);
    expect((await read.listClaims({ seller: a(scenario.agentWallet) }, page)).total).toBe(2);
    expect((await read.getClaim(a(scenario.paidJob)))?.address).toBe(a(scenario.claim));
    expect(await read.getClaim(a(scenario.agent))).toBeNull();
  });

  it("dispute'lar job'un dispute bilgisiyle", async () => {
    const list = await read.listDisputes({ jobStatus: 'disputed' }, page);
    expect(list.items.map((d) => d.job)).toEqual([a(scenario.disputedJob)]);
    const dispute = (await read.getDispute(a(scenario.disputedJob)))!;
    expect(dispute).toMatchObject({ jobStatus: 'disputed', institution: a(scenario.institution) });
    expect(dispute.dispute.raisedAt).toBe(1_790_000_500);
    expect(dispute.dispute.resolution).toEqual({ kind: 'pending' });
    expect((await read.listDisputes({ jobStatus: 'released' }, page)).total).toBe(0);
    expect(await read.getDispute(a(scenario.paidJob))).toBeNull();
  });

  it('screening tazeliği', async () => {
    expect((await read.getScreening(a(scenario.owner)))?.fresh).toBe(true);
    expect((await read.getScreening(a(scenario.agentWallet)))?.fresh).toBe(false);
    expect(await read.getScreening(a(scenario.agent))).toBeNull();
  });

  it("event'ler slot sırasıyla, filtrelerle", async () => {
    const all = await read.listEvents({}, { page: 1, limit: 200 });
    expect(all.total).toBe(scenario.events);
    const slots = all.items.map((event) => event.slot);
    expect([...slots].sort((x, y) => x - y)).toEqual(slots);
    const job = await read.listEvents({ job: a(scenario.paidJob) }, { page: 1, limit: 200 });
    expect(job.items.every((event) => (event.payload.data as { job?: string }).job === a(scenario.paidJob))).toBe(true);
    expect((await read.listEvents({ program: 'verifier', name: 'ReleaseRecorded' }, page)).total).toBe(1);
    expect((await read.listEvents({ fromSlot: slots.at(-1)! }, page)).items.every((e) => e.slot >= slots.at(-1)!)).toBe(
      true,
    );
    expect(all.items[0]!.blockTime).toBeGreaterThan(0);
  });
});
