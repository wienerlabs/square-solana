// Travel Rule (BE-23): şifreli saklama ve commitment, zincire yalnızca commitment'ın gitmesi, izinli okuma ve
// commitment'ın doğrulanması, erişim kaydı, saklama süresi ve ana anahtar döndürme.
import { randomBytes, randomUUID } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { travelRule } from '@squaresdk/solana-sdk';
import { squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import type { TravelRuleRecord } from '@squaresdk/solana-types';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createSecretBox } from '@squaresdk/solana-hardening';
import { createInstitutionAuthority } from '../src/institution-authority.js';
import { loadOpenApi } from '../src/openapi.js';
import { PERMISSION_INITIATE } from '../src/squads.js';
import { createTravelRuleService } from '../src/travel-rule/service.js';
import { apiKey, login } from './fixtures/login.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { World, wallet, type Wallet } from './fixtures/world.js';

const DAY = 86_400;
const RETENTION = 30 * DAY;
const KEYS = { k1: randomBytes(32), k2: randomBytes(32) };
const PASSPORT = 'U12345678';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

let stack: Stack;
let world: World;
let now: number;

beforeAll(async () => {
  stack = await startStack({
    openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
    clock: () => now,
    travelRule: { box: createSecretBox({ keys: KEYS, activeKeyId: 'k1' }), retentionSeconds: RETENTION },
  });
  world = new World(stack.db, stack.rpc, stack.client);
});
afterAll(() => stack.close());
beforeEach(async () => {
  await truncate(stack.db);
  stack.rpc.reset();
  now = Date.now();
});

const as = async (who: Wallet) => stack.api({ session: await login(stack.api(), who) });

/** `Open` iş; `signer` job'un kurum anahtarı (kurum anahtarı ya da vault). */
async function openJob(signer: string) {
  const agentWallet = wallet();
  const agent = await world.agent(wallet().address, agentWallet.address);
  const job = await world.job({
    institution: signer,
    agentRecord: agent,
    agentWallet: agentWallet.address,
    status: 'open',
  });
  const key = new PublicKey(job.address);
  // Açık işte henüz commitment bağlı değil (sıfır).
  await updateChainJob(key, { travelRuleCommitment: new Array(32).fill(0) });
  const onChain = (await stack.client.escrow.fetch('job', key))!;
  return { address: job.address, key, amount: onChain.amount.toString(10), mint: onChain.mint.toBase58(), agentWallet };
}

/** Zincirdeki job hesabını değiştirir (commitment bağlama, fonlama). */
async function updateChainJob(key: PublicKey, change: Record<string, unknown>) {
  const current = (await stack.client.escrow.fetch('job', key))!;
  await world.onChain('escrow', 'job', key, { ...current, ...change });
}

const recordFor = (job: { amount: string; mint: string; agentWallet: Wallet }): TravelRuleRecord => ({
  originator: {
    kind: 'legal',
    primaryIdentifier: 'Example Research Ltd',
    secondaryIdentifier: null,
    accountNumber: wallet().address,
    address: { street: '1 Example Street', city: 'London', postcode: 'EC1A 1AA', country: 'GB' },
    nationalIdentification: { type: 'LEIX', value: '5493001KJTIIGC8Y1R12', country: null },
    dateOfBirth: null,
    placeOfBirth: null,
    countryOfResidence: 'GB',
  },
  beneficiary: {
    kind: 'natural',
    primaryIdentifier: 'Yılmaz',
    secondaryIdentifier: 'Deniz',
    accountNumber: job.agentWallet.address,
    address: { street: 'Atatürk Cad. 12', city: 'İzmir', postcode: '35210', country: 'TR' },
    nationalIdentification: { type: 'CCPT', value: PASSPORT, country: 'TR' },
    dateOfBirth: '1990-04-12',
    placeOfBirth: 'İzmir',
    countryOfResidence: 'TR',
  },
  originatingVasp: { name: 'Example Custody AG', lei: '5493001KJTIIGC8Y1R12' },
  beneficiaryVasp: null,
  amount: job.amount,
  mint: job.mint,
});

describe('saklama ve paylaşım', () => {
  it('kurum saklar; düz metin yok, zincire yalnızca commitment gider; izinli karşı taraf okur ve doğrular', async () => {
    const [owner, counterparty] = [wallet(), wallet()];
    await world.institution(owner.address);
    const job = await openJob(owner.address);
    const record = recordFor(job);
    const institution = await as(owner);

    const stored = await institution.putTravelRule(job.address, { record });
    if (!stored.success) throw new Error(JSON.stringify(stored.error));
    expect(stored.data).toMatchObject({
      job: job.address,
      recordDigest: hex(travelRule.recordDigest(record)),
      storedBy: owner.address,
      retainUntil: stored.data.storedAt + RETENTION,
      purgedAt: null,
      chainCommitment: null,
      committed: false,
    });

    // Veritabanında kayıt ve salt yalnızca şifreli: hiçbir sütunda kişisel veri yok.
    const row = await stack.db.travelRuleRecord.findUniqueOrThrow({ where: { job: job.address } });
    const columns = Buffer.from(JSON.stringify(row, (_k, v: unknown) => (v instanceof Uint8Array ? hex(v) : v)));
    for (const bytes of [columns, Buffer.from(row.ciphertext!), Buffer.from(row.wrappedKey!)]) {
      for (const pii of ['Yılmaz', PASSPORT, 'Atatürk']) expect(bytes.includes(Buffer.from(pii))).toBe(false);
    }

    // `commitTravelRule` tx'i: veri olarak yalnızca 32 baytlık commitment.
    const prepared = await institution.prepareTx({
      call: { program: 'escrow', instruction: 'commitTravelRule', args: { commitment: stored.data.commitment } },
      accounts: { institution: owner.address, job: job.address },
      feePayer: owner.address,
      computeUnitPrice: null,
    });
    if (!prepared.success) throw new Error(JSON.stringify(prepared.error));
    const message = Buffer.from(
      VersionedTransaction.deserialize(Buffer.from(prepared.data.transaction, 'base64')).message.serialize(),
    );
    expect(message.includes(Buffer.from(stored.data.commitment, 'hex'))).toBe(true);
    for (const pii of ['Yılmaz', PASSPORT, record.originator.primaryIdentifier]) {
      expect(message.includes(Buffer.from(pii))).toBe(false);
    }
    await updateChainJob(job.key, { travelRuleCommitment: Array.from(Buffer.from(stored.data.commitment, 'hex')) });

    // İzinsiz karşı taraf okuyamaz; izinle okur ve commitment'ı kayıttan yeniden hesaplar.
    const peer = await as(counterparty);
    expect(await peer.getTravelRule(job.address)).toMatchObject({ error: { code: 'forbidden' } });
    now += 1_000;
    const expiresAt = Math.floor(now / 1000) + DAY;
    const granted = await institution.createTravelRuleGrant(job.address, {
      grantee: counterparty.address,
      purpose: 'karşı VASP: Travel Rule bilgisi',
      expiresAt,
    });
    expect(granted).toMatchObject({
      success: true,
      data: { grantee: counterparty.address, grantedBy: owner.address, expiresAt, revokedAt: null },
    });
    now += 1_000;
    const disclosed = await peer.getTravelRule(job.address);
    if (!disclosed.success) throw new Error(JSON.stringify(disclosed.error));
    expect(disclosed.data.record).toEqual(record);
    expect(disclosed.data.status).toMatchObject({ committed: true, chainCommitment: stored.data.commitment });
    const recomputed = travelRule.commitment({ job: job.key, salt: Buffer.from(disclosed.data.salt, 'hex'), record });
    expect(hex(recomputed)).toBe(disclosed.data.status.chainCommitment);

    // Erişim kaydı yalnızca kurumun yetkilisine; yeniden eskiye.
    expect(await peer.listTravelRuleAccess(job.address)).toMatchObject({ error: { code: 'forbidden' } });
    now += 1_000;
    await institution.deleteTravelRuleGrant(job.address, counterparty.address);
    expect(await peer.getTravelRule(job.address)).toMatchObject({ error: { code: 'forbidden' } });
    await expect(institution.deleteTravelRuleGrant(job.address, counterparty.address)).rejects.toMatchObject({
      status: 404,
    });
    const access = await institution.listTravelRuleAccess(job.address);
    if (!access.success) throw new Error(JSON.stringify(access.error));
    expect(access.meta.total).toBe(4);
    expect(access.data.map((entry) => [entry.action, entry.actor, entry.grantee])).toEqual([
      ['revoke', owner.address, counterparty.address],
      ['read', counterparty.address, null],
      ['grant', owner.address, counterparty.address],
      ['store', owner.address, null],
    ]);
    expect(access.data.every((entry) => entry.requestId !== null)).toBe(true);
  });

  it('süresi dolan izinle okunmaz; izin süresi gelecekte olmalı', async () => {
    const [owner, counterparty] = [wallet(), wallet()];
    await world.institution(owner.address);
    const job = await openJob(owner.address);
    const institution = await as(owner);
    await institution.putTravelRule(job.address, { record: recordFor(job) });
    const past = { grantee: counterparty.address, purpose: 'denetim', expiresAt: Math.floor(now / 1000) - 1 };
    expect(await institution.createTravelRuleGrant(job.address, past)).toMatchObject({
      error: { code: 'invalid_input' },
    });
    await institution.createTravelRuleGrant(job.address, { ...past, expiresAt: Math.floor(now / 1000) + 60 });
    const peer = await as(counterparty);
    expect((await peer.getTravelRule(job.address)).success).toBe(true);
    now += 61_000;
    expect(await peer.getTravelRule(job.address)).toMatchObject({ error: { code: 'forbidden' } });
  });
});

describe('yazma kuralları', () => {
  it('yalnızca açık işte ve job’un tutarı ve mint’iyle; yeniden yazma yeni salt; fonlanan işte değişmez', async () => {
    const [owner, stranger] = [wallet(), wallet()];
    await world.institution(owner.address);
    const job = await openJob(owner.address);
    const record = recordFor(job);
    const institution = await as(owner);

    expect(await (await as(stranger)).putTravelRule(job.address, { record })).toMatchObject({
      error: { code: 'forbidden' },
    });
    const key = await apiKey(stack, owner, ['read', 'tx:prepare']);
    expect(await stack.api({ apiKey: key }).putTravelRule(job.address, { record })).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect(await institution.putTravelRule(job.address, { record: { ...record, amount: '1' } })).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(
      await institution.putTravelRule(job.address, { record: { ...record, memo: 'x' } as TravelRuleRecord }),
    ).toMatchObject({ error: { code: 'invalid_input' } });
    expect(await institution.getTravelRule(job.address)).toMatchObject({ error: { code: 'not_found' } });

    const first = await institution.putTravelRule(job.address, { record });
    const second = await institution.putTravelRule(job.address, { record });
    expect(first.data!.recordDigest).toBe(second.data!.recordDigest);
    expect(first.data!.commitment).not.toBe(second.data!.commitment);
    expect(await stack.db.travelRuleRecord.count()).toBe(1);

    await updateChainJob(job.key, { status: { funded: {} } });
    expect(await institution.putTravelRule(job.address, { record })).toMatchObject({
      error: { code: 'conflict', details: { status: 'funded' } },
    });
    expect(await institution.putTravelRule(wallet().address, { record })).toMatchObject({
      error: { code: 'not_found' },
    });
    stack.rpc.failWith = 500;
    expect(await institution.putTravelRule(job.address, { record })).toMatchObject({
      error: { code: 'rpc_unavailable' },
    });
  });

  it('multisig bağlı kurumda Initiate yetkili üye yazar ve okur, kurum anahtarı yazamaz', async () => {
    const [owner, proposer, voter] = [wallet(), wallet(), wallet()];
    const multisig = world.squadsMultisig([
      { key: proposer.address, permissions: PERMISSION_INITIATE | 2 },
      { key: voter.address, permissions: 2 },
    ]);
    const institution = await world.institution(owner.address, { multisig });
    const vault = (await stack.db.institution.findUniqueOrThrow({ where: { address: institution } })).multisigVault!;
    const job = await openJob(vault);
    const record = recordFor(job);
    expect((await (await as(proposer)).putTravelRule(job.address, { record })).success).toBe(true);
    expect((await (await as(proposer)).getTravelRule(job.address)).success).toBe(true);
    for (const who of [voter, owner]) {
      expect(await (await as(who)).putTravelRule(job.address, { record })).toMatchObject({
        error: { code: 'forbidden' },
      });
    }
  });

  it('kurum smart account vault’uyla açıldıysa üye X-Square-Smart-Account ile yazar; kayıtlarda üyenin cüzdanı', async () => {
    const [proposer, voter] = [wallet(), wallet()];
    const multisig = world.squadsMultisig([
      { key: proposer.address, permissions: PERMISSION_INITIATE | 2 },
      { key: voter.address, permissions: 2 },
    ]);
    const vault = squadsVaultAddress(multisig, 0)[0].toBase58();
    await world.institution(vault);
    const job = await openJob(vault);
    const record = recordFor(job);
    const via = async (who: Wallet) =>
      stack.api({ session: await login(stack.api(), who), smartAccount: multisig.toBase58() });

    expect(await (await as(proposer)).putTravelRule(job.address, { record })).toMatchObject({
      error: { code: 'forbidden' },
    });
    const stored = await (await via(proposer)).putTravelRule(job.address, { record });
    if (!stored.success) throw new Error(stored.error.message);
    expect(stored.data.storedBy).toBe(proposer.address);
    expect((await (await via(proposer)).getTravelRule(job.address)).success).toBe(true);
    expect(await (await via(voter)).getTravelRule(job.address)).toMatchObject({ error: { code: 'forbidden' } });
    const access = await (await via(proposer)).listTravelRuleAccess(job.address);
    if (!access.success) throw new Error(access.error.message);
    // Test saati sabit: iki girdinin zamanı aynı, sıraları belirsiz.
    expect(access.data.map((entry) => `${entry.action}:${entry.actor}`).sort()).toEqual([
      `read:${proposer.address}`,
      `store:${proposer.address}`,
    ]);
  });
});

describe('saklama süresi ve anahtar döndürme', () => {
  it('süre dolunca şifreli kayıt silinir; commitment, özet ve erişim kaydı kalır', async () => {
    const owner = wallet();
    await world.institution(owner.address);
    const job = await openJob(owner.address);
    const institution = await as(owner);
    const stored = await institution.putTravelRule(job.address, { record: recordFor(job) });

    expect(await stack.travelRule.maintain()).toEqual({ purged: 0, rewrapped: 0 });
    now += RETENTION * 1000;
    expect(await stack.travelRule.maintain()).toEqual({ purged: 1, rewrapped: 0 });
    const row = await stack.db.travelRuleRecord.findUniqueOrThrow({ where: { job: job.address } });
    expect(row).toMatchObject({
      commitment: stored.data!.commitment,
      recordDigest: stored.data!.recordDigest,
      ciphertext: null,
      wrappedKey: null,
      keyId: null,
      purgedAt: new Date(now),
    });

    const session = await as(owner);
    expect(await session.getTravelRule(job.address)).toMatchObject({ error: { code: 'not_found' } });
    const grant = { grantee: wallet().address, purpose: 'denetim', expiresAt: Math.floor(now / 1000) + DAY };
    expect(await session.createTravelRuleGrant(job.address, grant)).toMatchObject({ error: { code: 'not_found' } });
    const access = await session.listTravelRuleAccess(job.address);
    expect(access.data!.map((entry) => [entry.action, entry.actor, entry.requestId])).toEqual([
      ['purge', null, null],
      ['store', owner.address, stored.meta.requestId],
    ]);
  });

  it('döndürmede veri anahtarı etkin anahtarla yeniden sarılır; kayıt açılır, halkada olmayan anahtarla açılmaz', async () => {
    const owner = wallet();
    await world.institution(owner.address);
    const job = await openJob(owner.address);
    const record = recordFor(job);
    await (await as(owner)).putTravelRule(job.address, { record });
    expect((await stack.db.travelRuleRecord.findFirstOrThrow()).keyId).toBe('k1');

    const service = (keys: Record<string, Uint8Array>, active: string) =>
      createTravelRuleService({
        db: stack.db,
        client: stack.client,
        authority: createInstitutionAuthority({
          db: stack.db,
          connection: stack.client.escrow.program.provider.connection,
        }),
        box: createSecretBox({ keys, activeKeyId: active }),
        retentionSeconds: RETENTION,
        clock: () => now,
      });
    const actor = { wallet: owner.address, smartAccount: null, requestId: randomUUID() };
    const rotated = service(KEYS, 'k2');
    expect(await rotated.maintain()).toEqual({ purged: 0, rewrapped: 1 });
    expect(await rotated.maintain()).toEqual({ purged: 0, rewrapped: 0 });
    expect((await stack.db.travelRuleRecord.findFirstOrThrow()).keyId).toBe('k2');
    expect((await rotated.disclose(actor, job.address)).record).toEqual(record);

    const retired = service({ k1: KEYS.k1 }, 'k1');
    await expect(retired.disclose(actor, job.address)).rejects.toThrow(/anahtar halkada yok: k2/);
    // Açılamayan okuma da erişim kaydındadır.
    expect(await stack.db.travelRuleAccess.count({ where: { action: 'read' } })).toBe(2);
  });
});
