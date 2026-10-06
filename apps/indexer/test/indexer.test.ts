// Uçtan uca: tarama (backfill + canlı), ayna tablolar, idempotency, kapanan hesap, imleç, uzlaştırma ve
// webhook kuyruğu. Veritabanı gerçek Postgres'tir (Testcontainers; Docker gerekir), zincir yerel fixture RPC.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createHealth } from '@squaresdk/solana-observability';
import { SQUARE_IDLS, type SquareProgramName } from '@squaresdk/solana-sdk';
import { ProgramEventPayloadSchema } from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, createMetricsApp } from '../src/app.js';
import { loadProgramIds } from '../src/programs.js';
import { FixtureChain, startRpcServer, type RpcServer } from './fixtures/rpc-server.js';
import { buildScenario, type Scenario } from './fixtures/scenario.js';
import { createStack, seedPrograms } from './fixtures/stack.js';
import { PROGRAM_IDS, World } from './fixtures/world.js';

let db: IsolatedDatabase;
let chain: FixtureChain;
let server: RpcServer;
let world: World;

beforeAll(async () => {
  db = await startIsolatedDatabase();
  chain = new FixtureChain();
  server = await startRpcServer(chain);
  world = new World(chain, server.url);
});
afterAll(async () => {
  await server.close();
  await db.stop();
});
beforeEach(async () => {
  await db.truncate();
  chain.reset();
  await seedPrograms(db.client);
});

const MIRROR_TABLES = [
  'institution',
  'policy',
  'agent',
  'screening',
  'job',
  'dispute',
  'claim',
  'agentReputation',
  'validationRecord',
  'releaseProof',
] as const;

/** Tabloların içeriği (indexer'ın zamanı hariç): idempotency karşılaştırması için. */
async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const table of MIRROR_TABLES) {
    const rows = (await (
      db.client[table] as unknown as { findMany(): Promise<Record<string, unknown>[]> }
    ).findMany()) as Record<string, unknown>[];
    out[table] = rows
      .map(({ indexedAt: _indexedAt, ...row }) =>
        JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)),
      )
      .sort();
  }
  const events = await db.client.chainEvent.findMany({
    orderBy: [{ slot: 'asc' }, { signature: 'asc' }, { instructionIndex: 'asc' }, { eventIndex: 'asc' }],
  });
  out.events = events.map(({ id: _id, indexedAt: _indexedAt, ...row }) =>
    JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)),
  );
  return out;
}

const address = (key: PublicKey) => key.toBase58();

describe('tarama', () => {
  let scenario: Scenario;
  beforeEach(async () => {
    scenario = await buildScenario(world);
  });

  it("senaryonun event'leri ve ayna tabloları yazılıyor; başarısız tx atlanıyor, kırpılmış log okunuyor", async () => {
    const stack = await createStack(db.client, [server.url]);
    const processed = await stack.poller.runOnce();
    expect(processed).toBeGreaterThan(0);
    const client = db.client;

    const events = await client.chainEvent.findMany();
    expect(events).toHaveLength(scenario.events);
    expect(events.every((event) => ProgramEventPayloadSchema.safeParse(event.payload).success)).toBe(true);
    expect(events.some((event) => event.signature === scenario.signatures.failed)).toBe(false);
    expect(events.filter((event) => event.signature === scenario.signatures.truncated).map((e) => e.name)).toEqual([
      'WorkSubmitted',
    ]);
    const finalize = events
      .filter((event) => event.signature === scenario.signatures.finalize)
      .sort((a, b) => a.eventIndex - b.eventIndex)
      .map((event) => [event.program, event.name, event.instructionIndex, event.eventIndex, event.job]);
    expect(finalize).toEqual([
      ['verifier', 'ReleaseRecorded', 1, 0, address(scenario.paidJob)],
      ['escrow', 'ReleaseVerified', 1, 1, address(scenario.paidJob)],
      ['escrow', 'ReputationRecorded', 1, 2, address(scenario.paidJob)],
      ['escrow', 'ValidationRecorded', 1, 3, address(scenario.paidJob)],
      ['escrow', 'Finalized', 1, 4, address(scenario.paidJob)],
    ]);

    const institution = await client.institution.findUniqueOrThrow({
      where: { address: address(scenario.institution) },
    });
    expect(institution).toMatchObject({
      ownerKey: address(scenario.owner),
      name: 'Example Research Ltd',
      multisigVault: null,
    });
    expect(await client.policy.count({ where: { institution: address(scenario.institution), active: true } })).toBe(1);
    expect(await client.agent.findUniqueOrThrow({ where: { address: address(scenario.agent) } })).toMatchObject({
      owner: address(scenario.owner),
      wallet: address(scenario.agentWallet),
      status: 'active',
    });
    expect((await client.screening.findMany()).map((s) => [s.wallet, s.status]).sort()).toEqual(
      [
        [address(scenario.owner), 'clear'],
        [address(scenario.agentWallet), 'flagged'],
      ].sort(),
    );
    const jobs = await client.job.findMany();
    expect(new Map(jobs.map((job) => [job.address, [job.status, job.closedSlot]]))).toEqual(
      new Map([
        [address(scenario.disputedJob), ['disputed', null]],
        [address(scenario.paidJob), ['released', null]],
      ]),
    );
    const dispute = await client.dispute.findUniqueOrThrow({ where: { job: address(scenario.disputedJob) } });
    expect(dispute).toMatchObject({
      jobStatus: 'disputed',
      resolution: 'pending',
      lapsed: false,
      raisedAt: 1_790_000_500n,
    });
    expect(await client.dispute.count()).toBe(1);
    expect(await client.claim.findUniqueOrThrow({ where: { address: address(scenario.claim) } })).toMatchObject({
      buyer: address(scenario.buyer),
      status: 'settled',
    });
    expect(await client.claim.findUniqueOrThrow({ where: { address: address(scenario.listedClaim) } })).toMatchObject({
      buyer: null,
      status: 'listed',
    });
    expect(await client.agentReputation.count({ where: { agentRecord: address(scenario.agent) } })).toBe(1);
    expect(
      await client.validationRecord.count({ where: { job: address(scenario.paidJob), outcome: 'verified' } }),
    ).toBe(1);
    // Lookup table'dan yüklenen yazılabilir hesap.
    expect(await client.releaseProof.count({ where: { job: address(scenario.paidJob), consumed: true } })).toBe(1);
    // Aynalanmayan config hesabı hiçbir tabloda yok.
    for (const table of MIRROR_TABLES.filter((t) => t !== 'dispute')) {
      const delegate = client[table] as unknown as { count(args: unknown): Promise<number> };
      expect(await delegate.count({ where: { address: address(scenario.escrowConfig) } })).toBe(0);
    }

    // Program başına imleç, programın son imzası.
    const cursors = await client.indexerCursor.findMany();
    expect(cursors.map((cursor) => cursor.program).sort()).toEqual(['escrow', 'policy', 'registry', 'verifier']);
    for (const cursor of cursors) {
      const newest = chain.signaturesFor(address(PROGRAM_IDS[cursor.program as SquareProgramName]), { limit: 1 })[0]!;
      expect(cursor.lastSignature).toBe(newest.signature);
    }
    expect(await stack.poller.runOnce()).toBe(0);
    expect(stack.poller.lastSuccessAt()).not.toBeNull();
  });

  it('yeniden işleme idempotent: imleçsiz tarama, aynı imzaların yeniden işlenmesi ve webhook aynı durumu verir', async () => {
    const stack = await createStack(db.client, [server.url]);
    await stack.poller.runOnce();
    const first = await snapshot();
    await db.client.indexerCursor.deleteMany();
    await stack.poller.runOnce();
    expect(await snapshot()).toEqual(first);
    const signatures = chain.txs.map((tx) => tx.signature);
    for (const signature of signatures) await stack.pipeline.process(signature);
    expect(await snapshot()).toEqual(first);
    expect(stack.queue.add(signatures).accepted).toBe(signatures.length);
    const drained = await stack.queue.drain();
    expect(drained).toEqual({ indexed: signatures.length - 1, waiting: 0 });
    expect(await snapshot()).toEqual(first);
  });

  it('kapanan alacak satırı kapalı işaretlenir, aynı adreste yeniden listelenince açılır', async () => {
    const stack = await createStack(db.client, [server.url]);
    await stack.poller.runOnce();
    chain.deleteAccount(address(scenario.listedClaim));
    world.tx({
      program: 'escrow',
      events: [{ program: 'escrow', name: 'claimCancelled', data: world.sample('escrow', 'claimCancelled') }],
      writable: [scenario.listedClaim],
    });
    await stack.poller.runOnce();
    const closed = await db.client.claim.findUniqueOrThrow({ where: { address: address(scenario.listedClaim) } });
    expect(closed.closedSlot).not.toBeNull();
    expect(closed.closedSlot).toBe(closed.slot);

    await world.put(
      'escrow',
      'claimListing',
      scenario.listedClaim,
      world.sample('escrow', 'claimListing', {
        job: scenario.disputedJob,
        buyer: PublicKey.default,
        status: { listed: {} },
      }),
    );
    world.tx({
      program: 'escrow',
      events: [{ program: 'escrow', name: 'claimListed', data: world.sample('escrow', 'claimListed') }],
      writable: [scenario.listedClaim],
    });
    await stack.poller.runOnce();
    const reopened = await db.client.claim.findUniqueOrThrow({ where: { address: address(scenario.listedClaim) } });
    expect(reopened.closedSlot).toBeNull();
    expect(reopened.slot).toBeGreaterThanOrEqual(closed.slot);

    // Aynalanan ama kapanamayan hesap zincirden kalkarsa satır silinir.
    chain.deleteAccount(address(scenario.validation));
    world.tx({ program: 'escrow', writable: [scenario.validation] });
    await stack.poller.runOnce();
    expect(await db.client.validationRecord.count()).toBe(0);
  });

  it('daha eski bir okuma daha yeni satırı ezmez', async () => {
    const stack = await createStack(db.client, [server.url]);
    await stack.poller.runOnce();
    const job = await db.client.job.findUniqueOrThrow({ where: { address: address(scenario.paidJob) } });
    await db.client.job.update({
      where: { address: job.address },
      data: { slot: BigInt(chain.slot + 1_000), status: 'refunded' },
    });
    await stack.pipeline.process(scenario.signatures.finalize);
    expect((await db.client.job.findUniqueOrThrow({ where: { address: job.address } })).status).toBe('refunded');
  });
});

describe('imleç ve sayfalama', () => {
  it('küçük sayfalarla bütün geçmiş eskiden yeniye işlenir; okunamayan tx imleci durdurur', async () => {
    const signatures = Array.from({ length: 5 }, () =>
      world.tx({
        program: 'policy',
        events: [{ program: 'policy', name: 'policyDeactivated', data: world.sample('policy', 'policyDeactivated') }],
      }),
    );
    const stack = await createStack(db.client, [server.url], { pageSize: 2 });
    expect(await stack.poller.runOnce()).toBe(5);
    const order = (await db.client.chainEvent.findMany({ orderBy: { id: 'asc' } })).map((event) => event.signature);
    expect(order).toEqual(signatures);

    const late = world.tx({ program: 'policy' });
    const later = world.tx({ program: 'policy' });
    chain.unavailable.add(late);
    expect(await stack.poller.runOnce()).toBe(0);
    expect((await db.client.indexerCursor.findUniqueOrThrow({ where: { program: 'policy' } })).lastSignature).toBe(
      signatures.at(-1),
    );
    chain.unavailable.delete(late);
    expect(await stack.poller.runOnce()).toBe(2);
    expect((await db.client.indexerCursor.findUniqueOrThrow({ where: { program: 'policy' } })).lastSignature).toBe(
      later,
    );
  });
});

describe('uzlaştırma', () => {
  it('tarama sonrası sapma 0; bozulan tablolar raporlanır, onarılır ve yeniden 0 olur', async () => {
    const scenario = await buildScenario(world);
    const stack = await createStack(db.client, [server.url]);
    await stack.poller.runOnce();
    const clean = await stack.reconciler.run({ repair: false });
    expect(clean.drift).toBe(0);
    expect(clean.tables.map((table) => table.table).sort()).toEqual(
      [
        'agent_reputations',
        'agents',
        'claims',
        'disputes',
        'institutions',
        'jobs',
        'policies',
        'release_proofs',
        'screenings',
        'validation_records',
      ].sort(),
    );
    expect(stack.reconciler.lastDrift()).toBe(0);

    // Bozma: eksik job, eski politika JSON'u, zincirde olmayan agent, eksik dispute, kapalı sanılan alacak.
    await db.client.job.delete({ where: { address: address(scenario.paidJob) } });
    const policy = await db.client.policy.findUniqueOrThrow({ where: { address: address(scenario.policy) } });
    await db.client.policy.update({
      where: { address: policy.address },
      data: { account: { ...(policy.account as object), active: false } },
    });
    const orphan = await db.client.agent.findUniqueOrThrow({ where: { address: address(scenario.agent) } });
    const { address: _address, ...agentColumns } = orphan;
    await db.client.agent.create({
      data: { ...agentColumns, address: world.key().toBase58(), agentId: 'orphan', account: orphan.account as object },
    });
    await db.client.dispute.deleteMany();
    await db.client.claim.update({ where: { address: address(scenario.claim) }, data: { closedSlot: 5n } });
    // Zincirde tx'i görülmeden değişen hesap (ör. kaçırılmış bildirim): itibar güncellendi.
    await world.put(
      'escrow',
      'agentReputation',
      scenario.reputation,
      world.sample('escrow', 'agentReputation', { agentRecord: scenario.agent }),
    );

    const report = await stack.reconciler.run({ repair: true });
    const byTable = Object.fromEntries(report.tables.map((t) => [t.table, t]));
    expect(byTable.jobs).toMatchObject({ missing: 1, stale: 0, orphaned: 0 });
    expect(byTable.policies).toMatchObject({ missing: 0, stale: 1, orphaned: 0 });
    expect(byTable.agents).toMatchObject({ missing: 0, stale: 0, orphaned: 1 });
    expect(byTable.disputes).toMatchObject({ missing: 1 });
    expect(byTable.claims).toMatchObject({ missing: 1 });
    expect(byTable.agent_reputations).toMatchObject({ stale: 1 });
    expect(report.drift).toBe(6);
    expect(report.repaired).toBe(true);
    expect(byTable.jobs!.samples).toEqual([address(scenario.paidJob)]);

    const after = await stack.reconciler.run({ repair: false });
    expect(after.drift).toBe(0);
    expect(await db.client.dispute.count()).toBe(1);
    expect(
      (await db.client.claim.findUniqueOrThrow({ where: { address: address(scenario.claim) } })).closedSlot,
    ).toBeNull();

    // Okumadan yeni slot'ta yazılmış satır sapma sayılmaz.
    await db.client.policy.update({
      where: { address: policy.address },
      data: { slot: BigInt(chain.slot + 10), account: { ...(policy.account as object), version: 99 } },
    });
    expect((await stack.reconciler.run({ repair: false })).drift).toBe(0);
  });

  it('sözleşme IDL’iyle çözülemeyen hesap atlanır, sayılır ve uzlaştırmada sapma dışında raporlanır', async () => {
    const stack = await createStack(db.client, [server.url]);
    const kind = stack.codec.accountKinds.find((k) => k.kind === 'AgentRecord')!;
    const legacy = world.key();
    chain.setAccount(legacy.toBase58(), {
      owner: kind.programId.toBase58(),
      data: Buffer.concat([Buffer.from(kind.discriminator), Buffer.alloc(200, 0xff)]),
      lamports: 1,
    });
    const agent = world.key();
    await world.put('registry', 'agentRecord', agent, world.sample('registry', 'agentRecord'));
    world.tx({ program: 'registry', writable: [legacy, agent] });
    expect(await stack.poller.runOnce()).toBe(1);
    expect((await db.client.agent.findMany()).map((row) => row.address)).toEqual([agent.toBase58()]);
    const metrics = await stack.metrics.registry.metrics();
    expect(metrics).toContain('indexer_undecodable_accounts_total{program="registry",kind="AgentRecord"');

    const report = await stack.reconciler.run({ repair: false });
    expect(report.drift).toBe(0);
    expect(report.tables.find((table) => table.table === 'agents')).toMatchObject({
      checked: 1,
      undecodable: 1,
      samples: [legacy.toBase58()],
    });
  });
});

describe('webhook kuyruğu', () => {
  it('kesinleşen işlenir, kesinleşmeyen bekler, başarısız ve süresi geçen bırakılır', async () => {
    let now = 1_000_000;
    const stack = await createStack(db.client, [server.url], {
      maxPending: 4,
      pendingTtlSeconds: 30,
      clock: () => now,
    });
    const job = world.key();
    await world.put('escrow', 'job', job, world.sample('escrow', 'job'));
    const finalized = world.tx({ program: 'escrow', writable: [job] });
    const confirmed = world.tx({ program: 'escrow', finalized: false });
    const failed = world.tx({ program: 'escrow', err: { InstructionError: [0, { Custom: 1 }] } });
    const unknown = 'u'.repeat(64);

    expect(stack.queue.add([finalized, confirmed, failed, finalized])).toEqual({
      accepted: 3,
      duplicate: 1,
      dropped: 0,
    });
    expect(stack.queue.add([unknown, world.tx({ program: 'escrow' })])).toEqual({
      accepted: 1,
      duplicate: 0,
      dropped: 1,
    });
    expect(await stack.queue.drain()).toEqual({ indexed: 1, waiting: 2 });
    expect(await db.client.job.count({ where: { address: job.toBase58() } })).toBe(1);
    now += 31_000;
    expect(await stack.queue.drain()).toEqual({ indexed: 0, waiting: 0 });
    expect(stack.queue.size()).toBe(0);
    expect(await stack.queue.drain()).toEqual({ indexed: 0, waiting: 0 });
  });

  it('işlenemeyen imza kuyrukta kalır', async () => {
    const stack = await createStack(db.client, [server.url]);
    // Sözleşmede olmayan event: indexer'ın IDL'i programın gerisinde, tx yazılmaz.
    const signature = world.tx({ program: 'escrow', rawData: ['AAAAAAAAAAA='] });
    stack.queue.add([signature]);
    expect(await stack.queue.drain()).toEqual({ indexed: 0, waiting: 1 });
    await expect(stack.pipeline.process(signature)).rejects.toThrow(/IDL'de olmayan event/);
  });
});

describe('programlar', () => {
  it('tablo eksikse ya da IDL sürümü farklıysa açılmaz', async () => {
    expect((await loadProgramIds(db.client)).escrow.equals(PROGRAM_IDS.escrow)).toBe(true);
    await db.client.program.update({ where: { name: 'policy' }, data: { idlVersion: '9.9.9' } });
    await db.client.program.delete({ where: { name: 'escrow' } });
    const error = await loadProgramIds(db.client).then(
      () => null,
      (reason: unknown) => reason as Error,
    );
    expect(error?.message).toContain(`policy: IDL sürümü 9.9.9, servisinki ${SQUARE_IDLS.policy.metadata.version}`);
    expect(error?.message).toContain('escrow: programs tablosunda yok');
  });
});

describe('HTTP yüzeyi', () => {
  const AUTH = 'Bearer helius-webhook-test';
  const authSha256 = createHash('sha256').update(AUTH).digest('hex');

  async function serve(webhook: boolean) {
    const stack = await createStack(db.client, [server.url]);
    const health = createHealth({
      version: '0.0.0',
      checks: {
        database: async () => {
          await db.client.$queryRaw`SELECT 1`;
        },
        rpc: async () => {
          await stack.chain.finalizedSlot();
        },
      },
      timeoutMs: 2_000,
      logger: stack.log,
    });
    const app = createApp({
      health,
      metrics: stack.metrics,
      log: stack.log,
      webhook: webhook ? { authSha256, maxBodyBytes: 1_024, queue: stack.queue } : null,
    });
    const http = app.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const metricsHttp = createMetricsApp(stack.metrics.registry, stack.log).listen(0, '127.0.0.1');
    await once(metricsHttp, 'listening');
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const metricsBase = `http://127.0.0.1:${(metricsHttp.address() as AddressInfo).port}`;
    return {
      stack,
      base,
      metricsBase,
      close: async () => {
        http.close();
        metricsHttp.close();
      },
    };
  }

  it('health, ready, webhook yetkisi ve gövdesi, metrikler', async () => {
    const { stack, base, metricsBase, close } = await serve(true);
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const ready = await fetch(`${base}/ready`);
      expect(ready.status).toBe(200);
      expect(((await ready.json()) as { checks: Record<string, string> }).checks).toEqual({
        database: 'ok',
        rpc: 'ok',
      });

      const signature = world.tx({ program: 'escrow' });
      const post = (body: string, authorization?: string) =>
        fetch(`${base}/webhooks/helius`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
          body,
        });
      const payload = JSON.stringify([{ transaction: { signatures: [signature] }, meta: { err: null } }]);
      expect((await post(payload)).status).toBe(401);
      expect((await post(payload, 'Bearer wrong')).status).toBe(401);
      expect((await post('{"not":"array"}', AUTH)).status).toBe(400);
      expect((await post('[{', AUTH)).status).toBe(400);
      expect((await post(JSON.stringify([{ signature: 'x'.repeat(2_000) }]), AUTH)).status).toBe(413);
      const accepted = await post(payload, AUTH);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ accepted: 1, duplicate: 0, dropped: 0 });
      expect(stack.queue.size()).toBe(1);
      expect((await fetch(`${base}/nope`)).status).toBe(404);

      const metrics = await (await fetch(`${metricsBase}/metrics`)).text();
      expect(metrics).toContain('indexer_webhook_signatures_total{result="accepted"');
      expect(metrics).toContain('indexer_webhook_pending');
      expect((await fetch(`${metricsBase}/other`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it('webhook kapalıyken uç yok; bağımlılık düşünce hazır değil', async () => {
    const { base, close } = await serve(false);
    try {
      expect((await fetch(`${base}/webhooks/helius`, { method: 'POST' })).status).toBe(404);
      server.failWith = 500;
      const ready = await fetch(`${base}/ready`);
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as { checks: Record<string, string> }).checks.rpc).toBe('fail');
    } finally {
      server.failWith = null;
      await close();
    }
  });
});
