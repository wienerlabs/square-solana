// `cctp_transfers` deposu ve görünüm, gerçek Postgres'te (migration'lar ve kısıtlarıyla).
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { CctpTransferSchema } from '@squaresdk/solana-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTransferStore, toView, type NewTransfer, type TransferStore } from '../src/store.js';

let db: IsolatedDatabase;
let store: TransferStore;

beforeAll(async () => {
  db = await startIsolatedDatabase();
  store = createTransferStore(db.client);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.truncate();
});

const address = () => Keypair.generate().publicKey.toBase58();
const txHash = () => `0x${randomBytes(32).toString('hex')}`;
const transfer = (overrides: Partial<NewTransfer> = {}): NewTransfer => ({
  sourceDomain: 0,
  sourceTxHash: txHash(),
  job: address(),
  institution: address(),
  mintRecipient: address(),
  ...overrides,
});
const attestedPatch = () => ({
  status: 'attested' as const,
  nonce: randomBytes(32).toString('hex'),
  message: 'ab'.repeat(376),
  attestation: 'cd'.repeat(130),
  amount: 5_000_000n,
  feeExecuted: 500n,
  attestedAt: new Date('2026-10-06T12:00:00Z'),
});

describe('kayıt', () => {
  it('kaynak tx başına tek satır; ikinci kayıt null döner', async () => {
    const input = transfer();
    const created = await store.create(input);
    expect(created).toMatchObject({ ...input, status: 'pendingAttestation', attempts: 0, nonce: null, amount: null });
    expect(await store.create({ ...input, job: address() })).toBeNull();
    expect((await store.findBySource(0, input.sourceTxHash))?.id).toBe(created!.id);
    expect(await store.findBySource(6, input.sourceTxHash)).toBeNull();
    expect(await store.find(created!.id)).toEqual(created);
  });

  it('kısıtlar: büyük harf tx hash, kısmi attestation alanları, durumsuz nonce reddedilir', async () => {
    await expect(
      store.create(transfer({ sourceTxHash: txHash().toUpperCase().replace('0X', '0x') })),
    ).rejects.toThrow();
    const row = (await store.create(transfer()))!;
    await expect(store.update(row.id, { status: 'attested' })).rejects.toThrow();
    await expect(store.update(row.id, { nonce: randomBytes(32).toString('hex') })).rejects.toThrow();
    await expect(store.update(row.id, { ...attestedPatch(), message: 'XYZ' })).rejects.toThrow();
  });
});

describe('güncelleme, görünüm ve sorgular', () => {
  it('attestation alanları ve tutarlar; görünüm sözleşmenin şemasında, mint edilen tutar hesaplanır', async () => {
    const row = (await store.create(transfer()))!;
    const updated = await store.update(row.id, { ...attestedPatch(), attempts: 0, nextAttemptAt: null });
    expect(updated).toMatchObject({ status: 'attested', amount: 5_000_000n, feeExecuted: 500n });
    const view = CctpTransferSchema.parse(toView(updated));
    expect(view).toMatchObject({ amount: '5000000', feeExecuted: '500', minted: '4999500', attestedAt: 1_791_288_000 });
    expect(CctpTransferSchema.parse(toView(row))).toMatchObject({
      minted: null,
      attestedAt: null,
      nextAttemptAt: null,
    });
  });

  it('liste süzgeçleri ve sayfalar, yeniden eskiye', async () => {
    const job = address();
    const institution = address();
    const first = (await store.create(transfer({ job, institution })))!;
    const second = (await store.create(transfer({ job, institution })))!;
    await store.create(transfer());
    await store.update(second.id, { status: 'failed', error: 'x' });
    expect((await store.list({ job }, { page: 1, limit: 10 })).items.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(await store.list({ institution, status: 'failed' }, { page: 1, limit: 10 })).toMatchObject({ total: 1 });
    const page = await store.list({}, { page: 2, limit: 2 });
    expect(page).toMatchObject({ total: 3 });
    expect(page.items).toHaveLength(1);
  });

  it('zamanı gelenler: açık durumda, bakışı geçmiş ya da hiç bakılmamış, en eski önce; sayılar', async () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const a = (await store.create(transfer()))!;
    const b = (await store.create(transfer()))!;
    const c = (await store.create(transfer()))!;
    const d = (await store.create(transfer()))!;
    await store.update(b.id, { nextAttemptAt: new Date(now.getTime() + 1000) });
    await store.update(c.id, { nextAttemptAt: new Date(now.getTime() - 1000), ...attestedPatch() });
    await store.update(d.id, { status: 'failed', error: 'x' });
    expect((await store.due(now, 10)).map((r) => r.id)).toEqual([a.id, c.id]);
    expect((await store.due(now, 1)).map((r) => r.id)).toEqual([a.id]);
    expect(await store.openCounts()).toEqual({ pendingAttestation: 2, attested: 1, received: 0 });
  });
});
