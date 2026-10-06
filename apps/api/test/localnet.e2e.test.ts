// Uyuşmazlık uçtan uca, localnet (BE-22): gerçek programlar `solana-test-validator`'da, gerçek indexer ve keeper
// süreçleri, API bu dosyada (fixtures/localnet.ts). `SQUARE_LOCALNET=1` ile çalışır; yoksa atlanır (CI'da validator yok).
//   A. Kurum kanıtı yükler (reasonHash) → `raise_dispute` → indexer aynası → arbitrator kuyruğu → iki arbitrator
//      API'nin hazırladığı `resolve_dispute` tx'lerini imzalar → `execute_resolution` → ödeme ve bond agent'a.
//   B. `raise_dispute` → son tarih geçer → keeper'ın lapse crank'i `lapse_dispute` gönderir → bond kuruma döner,
//      iş `Delivered`'a döner, günlükte `confirmed`.
import { createHash } from 'node:crypto';
import { VersionedTransaction, type PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login } from './fixtures/login.js';
import { startLocalnet, until, type Localnet } from './fixtures/localnet.js';

const ENABLED = process.env['SQUARE_LOCALNET'] === '1';

/** Dispute son tarihi: indexer'ın kesinleşmiş aynası (~15 sn) ve iki oy sığar. */
const DISPUTE_TIMEOUT_SECS = 60;
const AMOUNT = 10_000_000n;
const BOND = 1_000_000n;

describe.skipIf(!ENABLED)('localnet: dispute uçtan uca', () => {
  let world: Localnet;

  beforeAll(async () => {
    world = await startLocalnet({ disputeTimeoutSecs: DISPUTE_TIMEOUT_SECS, keeper: true });
  }, 240_000);

  afterAll(async () => {
    await world?.close();
  });

  async function raise(job: PublicKey, reasonHash: Uint8Array) {
    const { institution, institutionAta } = world;
    await world.send(
      await world.stack.client.flow.raiseDispute(
        {
          institution: institution.keypair.publicKey,
          job,
          reasonHash,
          bond: BOND,
          institutionTokenAccount: institutionAta,
        },
        { feePayer: institution.keypair.publicKey },
      ),
      [institution.keypair],
    );
  }

  it('A: kanıt → raise → kuyruk → iki oy (API) → execute; B: raise → son tarih → keeper lapse', async () => {
    const { stack, connection, institution, agentWallet, panel, admin } = world;
    const { client } = stack;
    const balance = world.balance;
    const api = stack.api({ session: await login(stack.api(), institution) });
    const jobA = await world.deliveredJob('job-a', AMOUNT);
    const jobB = await world.deliveredJob('job-b', AMOUNT);

    // Kurum gerekçesini yükler; dönen hash raise_dispute'un argümanıdır. Yükleme job aynasını ister: indexer
    // teslim edilmiş job'u yazana kadar beklenir.
    await until('job aynası', 90_000, async () => {
      const row = await stack.db.job.findUnique({ where: { address: jobA.toBase58() } });
      return row?.status === 'delivered';
    });
    const reason = 'Teslimat şartnamedeki 3 maddeyi karşılamıyor.';
    const evidence = await api.uploadDisputeEvidence(jobA.toBase58(), new Blob([reason], { type: 'text/plain' }));
    if (!evidence.success) throw new Error(JSON.stringify(evidence.error));
    await raise(jobA, Buffer.from(evidence.data.reasonHash, 'hex'));
    await raise(jobB, createHash('sha256').update('job-b gerekçesi').digest());
    const raisedAt = Date.now();

    // Indexer kesinleşmiş tx'lerden dispute aynasını yazar.
    await until('dispute aynası', 90_000, () => stack.db.dispute.findUnique({ where: { job: jobA.toBase58() } }));
    const listed = await api.listDisputeEvidence(jobA.toBase58());
    expect(listed.success && listed.data[0]).toMatchObject({ isDisputeReason: true, role: 'institution' });

    const [first, second] = [panel[0]!, panel[1]!];
    const firstApi = stack.api({ session: await login(stack.api(), first) });
    const queue = await firstApi.getArbitrationQueue();
    if (!queue.success) throw new Error(queue.error.message);
    const item = queue.data.find((entry) => entry.dispute.job === jobA.toBase58())!;
    expect(item).toMatchObject({ hasVoted: false, canVote: true, threshold: 2 });
    expect(item.evidence.map((e) => e.reasonHash)).toEqual([evidence.data.reasonHash]);

    for (const arbitrator of [first, second]) {
      const arbitratorApi =
        arbitrator === first ? firstApi : stack.api({ session: await login(stack.api(), arbitrator) });
      const prepared = await arbitratorApi.prepareDisputeVote(jobA.toBase58(), {
        resolution: { kind: 'favorAgent' },
        feePayer: null,
        computeUnitPrice: null,
      });
      if (!prepared.success) throw new Error(JSON.stringify(prepared.error));
      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.data.transaction, 'base64'));
      tx.sign([arbitrator.keypair]);
      const signature = await connection.sendRawTransaction(tx.serialize());
      const confirmed = await connection.confirmTransaction(
        { signature, blockhash: prepared.data.blockhash, lastValidBlockHeight: prepared.data.lastValidBlockHeight },
        'confirmed',
      );
      expect(confirmed.value.err).toBeNull();
    }
    // Karar verildi: üçüncü oy ön denetimde reddedilir.
    const third = await stack
      .api({ session: await login(stack.api(), panel[2]!) })
      .prepareDisputeVote(jobA.toBase58(), {
        resolution: { kind: 'favorAgent' },
        feePayer: null,
        computeUnitPrice: null,
      });
    expect(third).toMatchObject({ error: { code: 'conflict' } });
    const decided = await client.escrow.fetch('job', jobA);
    expect(Object.keys(decided!.status)).toEqual(['resolved']);
    expect(decided!.dispute.approvalCount).toBe(2);

    const agentBefore = await balance(agentWallet.keypair.publicKey);
    await world.send(
      await client.flow.executeResolution(
        { caller: admin.keypair.publicKey, job: jobA },
        { feePayer: admin.keypair.publicKey },
      ),
      [admin.keypair],
    );
    // FavorAgent: escrow ve bond agent tarafına (policy'siz iş; keeper ücreti kesilmez).
    expect((await balance(agentWallet.keypair.publicKey)) - agentBefore).toBe(AMOUNT + BOND);

    // B: son tarih geçince keeper lapse eder; bond kuruma döner.
    const institutionBefore = await balance(institution.keypair.publicKey);
    const lapse = await until('keeper lapse', (DISPUTE_TIMEOUT_SECS + 120) * 1000, () =>
      stack.db.keeperAction.findFirst({
        where: { job: jobB.toBase58(), action: 'lapseDispute', outcome: 'confirmed' },
      }),
    );
    expect(Date.now() - raisedAt).toBeGreaterThanOrEqual((DISPUTE_TIMEOUT_SECS - 5) * 1000);
    expect(lapse.signature).toBeTruthy();
    const lapsed = await client.escrow.fetch('job', jobB);
    expect(Object.keys(lapsed!.status)).toEqual(['delivered']);
    expect(lapsed!.dispute.lapsed).toBe(true);
    expect((await balance(institution.keypair.publicKey)) - institutionBefore).toBe(BOND);
    // Indexer lapse'ı aynaya yazar.
    const mirrored = await until('lapse aynası', 90_000, async () => {
      const row = await stack.db.dispute.findUnique({ where: { job: jobB.toBase58() } });
      return row?.lapsed ? row : null;
    });
    expect(mirrored.jobStatus).toBe('delivered');
  }, 600_000);
});
