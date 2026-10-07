// Uyuşmazlık uçları (BE-22): dispute kanıtı (özel depo), arbitrator kuyruğu, oy ön denetimi ve tx hazırlığı,
// webhook abonelikleri. Escrow config'i ve job'lar fixture RPC'de, ayna satırları Postgres'te.
import { createHash } from 'node:crypto';
import { BN } from '@anchor-lang/core';
import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import type { BorshInstructionCoder } from '@anchor-lang/core';
import { squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadOpenApi } from '../src/openapi.js';
import { PERMISSION_INITIATE } from '../src/squads.js';
import { apiKey, login } from './fixtures/login.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { World, wallet, type Wallet } from './fixtures/world.js';

/** Testin "şimdi"si (ms) ve dispute'ların son tarihi. */
const NOW = 1_790_000_000;
const DEADLINE = NOW + 3 * 86_400;
const AMOUNT = 250_000_000n;

let stack: Stack;
let world: World;
let clock = NOW * 1000;
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const hexBytes = (hex: string) => Array.from(Buffer.from(hex, 'hex'));

let panel: Wallet[];
let institution: Wallet;
let agentOwner: Wallet;
let agentWallet: Wallet;
let agentRecord: string;

beforeAll(async () => {
  stack = await startStack({
    openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
    evidenceMaxBytes: 64,
    clock: () => clock,
  });
  world = new World(stack.db, stack.rpc, stack.client);
});
afterAll(() => stack.close());
beforeEach(async () => {
  await truncate(stack.db);
  stack.rpc.reset();
  clock = NOW * 1000;
  panel = [wallet(), wallet(), wallet()];
  institution = wallet();
  agentOwner = wallet();
  agentWallet = wallet();
  agentRecord = await world.agent(agentOwner.address, agentWallet.address);
  await world.escrowConfig(
    panel.map((p) => p.address),
    2,
    4,
    stack.client.pda.escrowConfig()[0],
  );
});

const session = async (who: Wallet) => stack.api({ session: await login(stack.api(), who) });

/** Dispute'lu job: `dispute` Anchor biçiminde alan değişiklikleri. */
const disputedJob = (dispute: Record<string, unknown> = {}, status = 'disputed', rejectionMask = 0) =>
  world.job({
    institution: institution.address,
    agentRecord,
    agentWallet: agentWallet.address,
    disputed: true,
    status,
    amount: AMOUNT,
    rejectionMask,
    dispute: {
      deadline: new BN(DEADLINE),
      arbitratorSetVersion: 4,
      approvalMask: 0,
      approvalCount: 0,
      ...dispute,
    },
  });

describe('dispute kanıtı', () => {
  it('kurum dispute’tan önce yükler; dönen reasonHash içeriğin SHA-256’sı, tekrar yükleme aynı kaydı döner', async () => {
    const job = await world.job({
      institution: institution.address,
      agentRecord,
      agentWallet: agentWallet.address,
      status: 'delivered',
    });
    const byInstitution = await session(institution);
    const reason = 'teslimat şartnamedeki 3 maddeyi karşılamıyor';
    const uploaded = await byInstitution.uploadDisputeEvidence(job.address, new Blob([reason], { type: 'text/plain' }));
    if (!uploaded.success) throw new Error(JSON.stringify(uploaded.error));
    expect(uploaded.data).toMatchObject({
      job: job.address,
      reasonHash: sha256(reason),
      contentType: 'text/plain',
      size: Buffer.byteLength(reason),
      role: 'institution',
      uploadedBy: institution.address,
      isDisputeReason: false,
    });
    const again = await byInstitution.uploadDisputeEvidence(job.address, new Blob([reason], { type: 'text/plain' }));
    expect(again.success && again.data.id).toBe(uploaded.data.id);
    expect(await stack.db.disputeEvidence.count()).toBe(1);

    // Dispute açılmadan agent ve arbitrator kanıt ekleyemez; yabancı hiç ekleyemez.
    const byAgent = await session(agentWallet);
    expect(await byAgent.uploadDisputeEvidence(job.address, new Blob(['x']))).toMatchObject({
      error: { code: 'conflict' },
    });
    expect(await (await session(panel[0]!)).uploadDisputeEvidence(job.address, new Blob(['x']))).toMatchObject({
      error: { code: 'conflict' },
    });
    expect(await (await session(wallet())).uploadDisputeEvidence(job.address, new Blob(['x']))).toMatchObject({
      error: { code: 'forbidden' },
    });
    // Teslimden önce kurum da yükleyemez.
    const accepted = await world.job({
      institution: institution.address,
      agentRecord,
      agentWallet: agentWallet.address,
    });
    expect(await byInstitution.uploadDisputeEvidence(accepted.address, new Blob(['x']))).toMatchObject({
      error: { code: 'conflict' },
    });
  });

  it('dispute’ta taraflar ekler ve okur; içerik özel depodan yalnızca taraflara iner', async () => {
    const reason = 'gerekçe: eksik teslimat';
    const job = await disputedJob({ reasonHash: hexBytes(sha256(reason)) });
    const byInstitution = await session(institution);
    const first = await byInstitution.uploadDisputeEvidence(job.address, new Blob([reason], { type: 'text/plain' }));
    expect(first.success && first.data.isDisputeReason).toBe(true);

    const ownerKey = await apiKey(stack, agentOwner, ['disputes:write', 'disputes:read']);
    const byOwner = stack.api({ apiKey: ownerKey });
    const reply = await byOwner.uploadDisputeEvidence(job.address, new Blob(['yanıt: tamamı teslim edildi']));
    expect(reply).toMatchObject({ success: true, data: { role: 'agent', uploadedBy: agentOwner.address } });
    const byArbitrator = await session(panel[1]!);
    const note = await byArbitrator.uploadDisputeEvidence(job.address, new Blob(['arbitrator notu']));
    expect(note).toMatchObject({ success: true, data: { role: 'arbitrator', isDisputeReason: false } });

    const listed = await byArbitrator.listDisputeEvidence(job.address);
    if (!listed.success) throw new Error(listed.error.message);
    expect(listed.data.map((e) => e.role)).toEqual(['institution', 'agent', 'arbitrator']);

    const content = await byOwner.getDisputeEvidenceContent(job.address, listed.data[0]!.id);
    expect(await content.text()).toBe(reason);
    expect(content.type).toMatch(/^text\/plain/);

    const stranger = await session(wallet());
    expect(await stranger.listDisputeEvidence(job.address)).toMatchObject({ error: { code: 'forbidden' } });
    await expect(stranger.getDisputeEvidenceContent(job.address, listed.data[0]!.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(byOwner.getDisputeEvidenceContent(job.address, 'yok')).rejects.toMatchObject({ status: 404 });
    await expect(
      byOwner.getDisputeEvidenceContent(job.address, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ status: 404 });
    // Depo herkese açık değil: kimliksiz okuma reddedilir.
    const s3 = inject('s3');
    const anonymous = await fetch(`${s3.endpoint}/${s3.evidenceBucket}/${job.address}/${sha256(reason)}`);
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
  });

  it('kurum Squads vault’uysa Initiate yetkili üye kurum sayılır', async () => {
    const member = wallet();
    const multisig = world.squadsMultisig([{ key: member.address, permissions: PERMISSION_INITIATE }]);
    const institutionPda = await world.institution(wallet().address, { multisig });
    const vault = (await stack.db.institution.findUniqueOrThrow({ where: { address: institutionPda } })).multisigVault!;
    const job = await world.job({
      institution: vault,
      agentRecord,
      agentWallet: agentWallet.address,
      status: 'delivered',
    });
    const uploaded = await (await session(member)).uploadDisputeEvidence(job.address, new Blob(['multisig gerekçesi']));
    expect(uploaded).toMatchObject({ success: true, data: { role: 'institution' } });
  });

  it('agent smart account vault’uysa üye X-Square-Smart-Account ile agent tarafıdır', async () => {
    const [member, voter] = [wallet(), wallet()];
    const multisig = world.squadsMultisig([
      { key: member.address, permissions: PERMISSION_INITIATE | 2 },
      { key: voter.address, permissions: 2 },
    ]);
    const vault = squadsVaultAddress(multisig, 0)[0].toBase58();
    const job = await world.job({
      institution: institution.address,
      agentRecord: await world.agent(vault, vault),
      agentWallet: vault,
      disputed: true,
    });
    const via = async (who: Wallet) =>
      stack.api({ session: await login(stack.api(), who), smartAccount: multisig.toBase58() });

    expect(await (await session(member)).uploadDisputeEvidence(job.address, new Blob(['x']))).toMatchObject({
      error: { code: 'forbidden' },
    });
    const uploaded = await (await via(member)).uploadDisputeEvidence(job.address, new Blob(['vault kanıtı']));
    expect(uploaded).toMatchObject({ success: true, data: { role: 'agent', uploadedBy: member.address } });
    expect((await (await via(member)).listDisputeEvidence(job.address)).success).toBe(true);
    expect(await (await via(voter)).listDisputeEvidence(job.address)).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('Squads vault’lu kurumun multisig’i okunamasa da agent ve arbitrator kanıtı okur ve yükler', async () => {
    const member = wallet();
    const multisig = world.squadsMultisig([{ key: member.address, permissions: PERMISSION_INITIATE }]);
    const institutionPda = await world.institution(wallet().address, { multisig });
    const vault = (await stack.db.institution.findUniqueOrThrow({ where: { address: institutionPda } })).multisigVault!;
    const job = await world.job({
      institution: vault,
      agentRecord,
      agentWallet: agentWallet.address,
      disputed: true,
      status: 'disputed',
      amount: AMOUNT,
      dispute: { deadline: new BN(DEADLINE), arbitratorSetVersion: 4, approvalMask: 0, approvalCount: 0 },
    });
    const byMember = await session(member);
    const uploaded = await byMember.uploadDisputeEvidence(job.address, new Blob(['kurumun gerekçesi']));
    if (!uploaded.success) throw new Error(uploaded.error.message);
    expect(uploaded.data.role).toBe('institution');
    stack.rpc.accounts.delete(multisig.toBase58());

    const byArbitrator = await session(panel[0]!);
    const content = await byArbitrator.getDisputeEvidenceContent(job.address, uploaded.data.id);
    expect(await content.text()).toBe('kurumun gerekçesi');
    expect(await byArbitrator.uploadDisputeEvidence(job.address, new Blob(['arbitrator notu']))).toMatchObject({
      success: true,
      data: { role: 'arbitrator' },
    });
    const listed = await (await session(agentWallet)).listDisputeEvidence(job.address);
    if (!listed.success) throw new Error(listed.error.message);
    expect(listed.data.map((e) => e.role)).toEqual(['institution', 'arbitrator']);
    expect(await byMember.listDisputeEvidence(job.address)).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('multisig okunamazken (503) okuma alttaki rolle sürer, yükleme yeniden denenmek üzere 503 alır', async () => {
    const multisig = world.squadsMultisig([{ key: wallet().address, permissions: PERMISSION_INITIATE }]);
    const institutionPda = await world.institution(wallet().address, { multisig });
    const vault = (await stack.db.institution.findUniqueOrThrow({ where: { address: institutionPda } })).multisigVault!;
    const job = await world.job({
      institution: vault,
      agentRecord,
      agentWallet: agentWallet.address,
      disputed: true,
      status: 'disputed',
      amount: AMOUNT,
      dispute: { deadline: new BN(DEADLINE), arbitratorSetVersion: 4, approvalMask: 0, approvalCount: 0 },
    });
    const byAgent = await session(agentWallet);
    expect(await byAgent.uploadDisputeEvidence(job.address, new Blob(['agent yanıtı']))).toMatchObject({
      success: true,
      data: { role: 'agent' },
    });
    stack.rpc.failWith = 503;
    const listed = await byAgent.listDisputeEvidence(job.address);
    expect(listed.success && listed.data.map((e) => e.role)).toEqual(['agent']);
    expect(await byAgent.uploadDisputeEvidence(job.address, new Blob(['ikinci yanıt']))).toMatchObject({
      error: { code: 'rpc_unavailable' },
    });
  });

  it('yetki, kapsam, boyut ve bilinmeyen job', async () => {
    const job = await disputedJob();
    expect(await stack.api().uploadDisputeEvidence(job.address, new Blob(['x']))).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect(await stack.api().listDisputeEvidence(job.address)).toMatchObject({ error: { code: 'unauthorized' } });
    const readOnly = stack.api({ apiKey: await apiKey(stack, institution, ['read']) });
    expect(await readOnly.uploadDisputeEvidence(job.address, new Blob(['x']))).toMatchObject({
      error: { code: 'forbidden', message: 'API anahtarının disputes:write kapsamı yok' },
    });
    expect(await readOnly.listDisputeEvidence(job.address)).toMatchObject({
      error: { code: 'forbidden', message: 'API anahtarının disputes:read kapsamı yok' },
    });
    const byInstitution = await session(institution);
    expect(await byInstitution.uploadDisputeEvidence(job.address, new Blob(['x'.repeat(65)]))).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(await byInstitution.uploadDisputeEvidence(agentWallet.address, new Blob(['x']))).toMatchObject({
      error: { code: 'not_found' },
    });
  });
});

describe('arbitrator kuyruğu', () => {
  it('açık dispute’lar son tarihe göre; oylar onay ve ret event’lerinden, oy durumu iki maskeden', async () => {
    // panel[0] öneriyi açtı (onay biti 0), panel[1] ret verdi (ret biti 1); set sürümü config'le aynı.
    const voted = await disputedJob(
      {
        approvalMask: 0b001,
        approvalCount: 1,
        resolution: { favorAgent: {} },
      },
      'disputed',
      0b010,
    );
    const later = await disputedJob({ deadline: new BN(DEADLINE + 100) });
    const expired = await disputedJob({ deadline: new BN(NOW - 1) });
    // Eski set sürümündeki oy sayılmaz: sonraki oy sayımı sıfırlar.
    const stale = await disputedJob({ deadline: new BN(DEADLINE + 200), approvalMask: 0b001, arbitratorSetVersion: 3 });
    await disputedJob({}, 'resolved');
    await world.chainEvent(voted.address, 'DisputeRaised', { deadline: new BN(DEADLINE) });
    await world.chainEvent(voted.address, 'DisputeVote', {
      arbitrator: new PublicKey(panel[0]!.address),
      resolution: { favorAgent: {} },
      approvalCount: 1,
    });
    await world.chainEvent(voted.address, 'DisputeVoteRejected', {
      arbitrator: new PublicKey(panel[1]!.address),
      resolution: { favorInstitution: {} },
      rejectionCount: 1,
      proposalReset: false,
    });

    const byFirst = await session(panel[0]!);
    const queue = await byFirst.getArbitrationQueue();
    if (!queue.success) throw new Error(queue.error.message);
    expect(queue.meta.total).toBe(4);
    expect(queue.data.map((item) => item.dispute.job)).toEqual([
      expired.address,
      voted.address,
      later.address,
      stale.address,
    ]);
    const [expiredItem, votedItem, laterItem, staleItem] = queue.data;
    expect(expiredItem).toMatchObject({ hasVoted: false, canVote: false, threshold: 2 });
    expect(votedItem).toMatchObject({ hasVoted: true, canVote: false });
    expect(votedItem!.votes).toEqual([
      expect.objectContaining({
        kind: 'approve',
        arbitrator: panel[0]!.address,
        resolution: { kind: 'favorAgent' },
        approvalCount: 1,
        rejectionCount: null,
        proposalReset: false,
      }),
      expect.objectContaining({
        kind: 'reject',
        arbitrator: panel[1]!.address,
        resolution: { kind: 'favorInstitution' },
        approvalCount: null,
        rejectionCount: 1,
        proposalReset: false,
      }),
    ]);
    expect(laterItem).toMatchObject({ hasVoted: false, canVote: true, votes: [] });
    expect(staleItem).toMatchObject({ hasVoted: false, canVote: true });

    const second = await (await session(panel[1]!)).getArbitrationQueue({ limit: 2, page: 1 });
    // panel[1]'in reti de oydur: aynı öneriye yeniden oy veremez.
    expect(second.success && second.data.map((item) => [item.hasVoted, item.canVote])).toEqual([
      [false, false],
      [true, false],
    ]);
    expect(await (await session(wallet())).getArbitrationQueue()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await stack.api().getArbitrationQueue()).toMatchObject({ error: { code: 'unauthorized' } });
    const readKey = stack.api({ apiKey: await apiKey(stack, panel[1]!, ['read']) });
    expect(await readKey.getArbitrationQueue()).toMatchObject({
      error: { code: 'forbidden', message: 'API anahtarının disputes:read kapsamı yok' },
    });
    const disputesKey = stack.api({ apiKey: await apiKey(stack, panel[1]!, ['disputes:read']) });
    expect((await disputesKey.getArbitrationQueue({ limit: 2, page: 1 })).success).toBe(true);
  });

  it('kuyruk, Squads vault’lu kurumun multisig’i okunamasa da açılır', async () => {
    const multisig = world.squadsMultisig([{ key: wallet().address, permissions: PERMISSION_INITIATE }]);
    const institutionPda = await world.institution(wallet().address, { multisig });
    const vault = (await stack.db.institution.findUniqueOrThrow({ where: { address: institutionPda } })).multisigVault!;
    const job = await world.job({
      institution: vault,
      agentRecord,
      agentWallet: agentWallet.address,
      disputed: true,
      status: 'disputed',
      amount: AMOUNT,
      dispute: { deadline: new BN(DEADLINE), arbitratorSetVersion: 4, approvalMask: 0, approvalCount: 0 },
    });
    stack.rpc.accounts.delete(multisig.toBase58());
    const queue = await (await session(panel[0]!)).getArbitrationQueue();
    if (!queue.success) throw new Error(queue.error.message);
    expect(queue.data.map((item) => item.dispute.job)).toContain(job.address);
  });

  it('escrow config okunamazsa 503', async () => {
    stack.rpc.accounts.delete(stack.client.pda.escrowConfig()[0].toBase58());
    expect(await (await session(panel[0]!)).getArbitrationQueue()).toMatchObject({
      error: { code: 'rpc_unavailable' },
    });
  });
});

describe('oy', () => {
  const decode = (base64: string) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
    const keys = tx.message.staticAccountKeys;
    const escrow = stack.client.escrow.program;
    const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(escrow.programId))!;
    const decoded = (escrow.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data))!;
    return {
      name: decoded.name,
      feePayer: keys[0]!.toBase58(),
      arbitrator: keys[ix.accountKeyIndexes[0]!]!.toBase58(),
    };
  };

  it('ön denetimden geçen oy için imzasız resolve_dispute tx’i', async () => {
    const job = await disputedJob({ approvalMask: 0b001, approvalCount: 1, resolution: { favorAgent: {} } });
    const bySecond = await session(panel[1]!);
    const prepared = await bySecond.prepareDisputeVote(job.address, {
      resolution: { kind: 'favorAgent' },
      feePayer: null,
      computeUnitPrice: null,
    });
    if (!prepared.success) throw new Error(JSON.stringify(prepared.error));
    expect(prepared.data.signers).toEqual([panel[1]!.address]);
    expect(decode(prepared.data.transaction)).toEqual({
      name: 'resolveDispute',
      feePayer: panel[1]!.address,
      arbitrator: panel[1]!.address,
    });
    const sponsor = wallet().address;
    const sponsored = await bySecond.prepareDisputeVote(job.address, {
      resolution: { kind: 'favorAgent' },
      feePayer: sponsor,
      computeUnitPrice: '5',
    });
    expect(sponsored.success && decode(sponsored.data.transaction).feePayer).toBe(sponsor);
  });

  it('üyelik, tekrar oy, ret oyu, son tarih, tutar ve durum denetimleri', async () => {
    const job = await disputedJob({ approvalMask: 0b001, approvalCount: 1, resolution: { favorAgent: {} } });
    const vote = (kind: 'favorAgent' | 'favorInstitution' | 'pending') =>
      ({ resolution: { kind }, feePayer: null, computeUnitPrice: null }) as const;
    expect(await (await session(panel[0]!)).prepareDisputeVote(job.address, vote('favorAgent'))).toMatchObject({
      error: { code: 'conflict', message: 'arbitrator bekleyen öneriye oy verdi' },
    });
    // Bekleyen öneriden farklı karar ret oyudur (ADR 0028); ret veren aynı öneriye yeniden oy veremez.
    const bySecond = await session(panel[1]!);
    const rejection = await bySecond.prepareDisputeVote(job.address, vote('favorInstitution'));
    if (!rejection.success) throw new Error(JSON.stringify(rejection.error));
    expect(decode(rejection.data.transaction).name).toBe('resolveDispute');
    const rejectedBySecond = await disputedJob(
      { approvalMask: 0b001, approvalCount: 1, resolution: { favorAgent: {} } },
      'disputed',
      0b010,
    );
    expect(await bySecond.prepareDisputeVote(rejectedBySecond.address, vote('favorAgent'))).toMatchObject({
      error: { code: 'conflict', message: 'arbitrator bekleyen öneriye oy verdi' },
    });
    expect(await bySecond.prepareDisputeVote(job.address, vote('pending'))).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(
      await bySecond.prepareDisputeVote(job.address, {
        resolution: { kind: 'split', agentAmount: (AMOUNT + 1n).toString() },
        feePayer: null,
        computeUnitPrice: null,
      }),
    ).toMatchObject({ error: { code: 'invalid_input', details: { amount: AMOUNT.toString() } } });
    expect(await (await session(wallet())).prepareDisputeVote(job.address, vote('favorAgent'))).toMatchObject({
      error: { code: 'forbidden' },
    });

    // Eski set sürümünde sayım sıfırlanacak: önceki oy ve karar engel değil.
    const reset = await disputedJob({
      approvalMask: 0b011,
      approvalCount: 2,
      arbitratorSetVersion: 3,
      resolution: { favorAgent: {} },
    });
    expect((await bySecond.prepareDisputeVote(reset.address, vote('favorInstitution'))).success).toBe(true);

    const expired = await disputedJob({ deadline: new BN(NOW) });
    expect(await bySecond.prepareDisputeVote(expired.address, vote('favorAgent'))).toMatchObject({
      error: { code: 'conflict', details: { deadline: NOW } },
    });
    const resolved = await disputedJob({}, 'resolved');
    expect(await bySecond.prepareDisputeVote(resolved.address, vote('favorAgent'))).toMatchObject({
      error: { code: 'conflict' },
    });
    expect(await bySecond.prepareDisputeVote(agentWallet.address, vote('favorAgent'))).toMatchObject({
      error: { code: 'not_found' },
    });
    // Zincir reddederse simülasyon hatası programError ile döner.
    const escrow = stack.client.programIds.escrow.toBase58();
    stack.rpc.simulations.push({
      err: { InstructionError: [1, { Custom: 6029 }] },
      logs: [`Program ${escrow} invoke [1]`, `Program ${escrow} failed: custom program error: 0x178d`],
      unitsConsumed: 1_000,
    });
    const rejected = await bySecond.prepareDisputeVote(job.address, vote('favorAgent'));
    expect(rejected).toMatchObject({ error: { code: 'simulation_failed', programError: { program: 'escrow' } } });
    // API anahtarı tx:prepare ister.
    const readOnly = stack.api({ apiKey: await apiKey(stack, panel[1]!, ['read']) });
    expect(await readOnly.prepareDisputeVote(job.address, vote('favorAgent'))).toMatchObject({
      error: { code: 'forbidden' },
    });
  });
});

describe('webhook abonelikleri', () => {
  it('aktif arbitrator https ucu kaydeder; sır bir kez döner ve şifreli saklanır', async () => {
    const bySecond = await session(panel[1]!);
    const created = await bySecond.createArbitrationWebhook({
      url: 'https://hooks.example.com/square',
      events: ['dispute.raised', 'dispute.deadline', 'dispute.raised'],
    });
    if (!created.success) throw new Error(JSON.stringify(created.error));
    expect(created.data.secret).toMatch(/^whsec_/);
    expect(created.data.webhook).toMatchObject({
      url: 'https://hooks.example.com/square',
      events: ['dispute.raised', 'dispute.deadline'],
    });
    const row = await stack.db.arbitrationWebhook.findUniqueOrThrow({ where: { id: created.data.webhook.id } });
    expect(row.secret).not.toContain(created.data.secret.slice(6));
    expect(stack.box.openText(row.secret, row.id)).toBe(created.data.secret);

    expect(await bySecond.listArbitrationWebhooks()).toMatchObject({ data: [{ id: created.data.webhook.id }] });
    expect(
      await bySecond.createArbitrationWebhook({ url: 'https://hooks.example.com/square', events: ['dispute.vote'] }),
    ).toMatchObject({ error: { code: 'conflict' } });
    for (const url of ['http://hooks.example.com/a', 'https://10.0.0.8/a', 'https://user:pw@hooks.example.com/a']) {
      expect(await bySecond.createArbitrationWebhook({ url, events: ['dispute.vote'] })).toMatchObject({
        error: { code: 'invalid_input' },
      });
    }
    expect(
      await bySecond.createArbitrationWebhook({ url: 'https://hooks.example.com/x', events: [] as never }),
    ).toMatchObject({ error: { code: 'invalid_input' } });
    expect(
      await (
        await session(wallet())
      ).createArbitrationWebhook({
        url: 'https://hooks.example.com/y',
        events: ['dispute.vote'],
      }),
    ).toMatchObject({ error: { code: 'forbidden' } });

    // Abonelik yalnızca oturumla yönetilir; başkasının aboneliği silinemez.
    const key = stack.api({ apiKey: await apiKey(stack, panel[1]!, ['read']) });
    expect(await key.listArbitrationWebhooks()).toMatchObject({ error: { code: 'unauthorized' } });
    await expect((await session(panel[0]!)).deleteArbitrationWebhook(created.data.webhook.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(bySecond.deleteArbitrationWebhook('yok')).rejects.toMatchObject({ status: 404 });
    await bySecond.deleteArbitrationWebhook(created.data.webhook.id);
    expect(await stack.db.arbitrationWebhook.count()).toBe(0);
  });

  it('arbitrator başına abonelik sınırı', async () => {
    const bySecond = await session(panel[1]!);
    for (let i = 0; i < 10; i += 1) {
      const created = await bySecond.createArbitrationWebhook({
        url: `https://hooks.example.com/${i}`,
        events: ['dispute.vote'],
      });
      expect(created.success).toBe(true);
    }
    expect(
      await bySecond.createArbitrationWebhook({ url: 'https://hooks.example.com/11', events: ['dispute.vote'] }),
    ).toMatchObject({ error: { code: 'conflict' } });
  });
});
