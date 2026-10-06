// Yazma tool'ları ve imza akışı: tool'lar imzasız tx döner; gönderim yalnızca tam ve geçerli imzalı tx'le olur.
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { specHashing } from '@squaresdk/solana-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeTransaction, LocalSigner } from '../src/transactions.js';
import { connect, type Harness } from './helpers/harness.js';
import { address, hex32, jobView, NOW, toBase64, unsignedTx } from './helpers/fixtures.js';

let h: Harness;
afterEach(async () => {
  await h.close();
});

const spec = { title: 'Translate the contract', language: 'tr', words: 1200 };
const specHash = Buffer.from(specHashing.specHash(spec)).toString('hex');

function openArgs(institution: string, overrides: Record<string, unknown> = {}) {
  return {
    institution,
    agentRecord: overrides.agentRecord ?? AGENT_RECORD,
    spec,
    amount: '5000000',
    deadline: NOW + 86_400,
    challengePeriod: '86400',
    ...overrides,
  };
}
const AGENT_RECORD = address();

describe('tool listesi', () => {
  it('yazma kipinde dört yazma tool’u eklenir', async () => {
    h = await connect();
    const { tools } = await h.client.listTools();
    const write = tools.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name);
    expect(write.sort()).toEqual([
      'square_accept_job',
      'square_deliver_work',
      'square_open_job',
      'square_submit_signed_transaction',
    ]);
    expect(tools).toHaveLength(9);
  });
});

describe('square_open_job', () => {
  it('job yoksa create_job hazırlar; tx imzasız döner ve gönderilmez', async () => {
    h = await connect();
    const institution = address();
    const { isError, body } = await h.call('square_open_job', openArgs(institution));
    expect(isError).toBe(false);
    const job = h.chain.jobAddress(new PublicKey(institution), Buffer.from(specHash, 'hex')).toBase58();
    expect(body).toMatchObject({
      step: 'createJob',
      nextStep: 'fundJob',
      job,
      specHash,
      signed: false,
      submitted: null,
    });
    expect(body.note).toMatch(/UNSIGNED/);
    const [request] = h.api.txRequests;
    expect(request).toEqual({
      call: {
        program: 'escrow',
        instruction: 'createJob',
        args: { specHash, amount: '5000000', deadline: NOW + 86_400, challengePeriod: '86400' },
      },
      accounts: {
        payer: institution,
        institution,
        agentRecord: AGENT_RECORD,
        mint: h.chain.settlementValue.mint.toBase58(),
        tokenProgram: h.chain.settlementValue.tokenProgram.toBase58(),
      },
      feePayer: institution,
      computeUnitPrice: null,
    });
    const summary = body.summary as Record<string, unknown>;
    expect(summary).toMatchObject({
      feePayer: institution,
      requiredSigners: [institution],
      signatures: [{ signer: institution, status: 'missing' }],
    });
    expect((summary.instructions as { program: string }[]).map((ix) => ix.program)).toEqual([
      'compute_budget',
      'square_escrow',
    ]);
    expect(decodeTransaction(body.transaction as string).signatures[0]!.every((b) => b === 0)).toBe(true);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('politika ve ayrı fee payer ile', async () => {
    h = await connect();
    const institution = address();
    const feePayer = address();
    const policy = address();
    const policyInstitution = address();
    h.api.policies.set(policy, { account: { institution: policyInstitution } } as never);
    const { body } = await h.call('square_open_job', {
      ...openArgs(institution),
      policy,
      feePayer,
      computeUnitPrice: '5000',
    });
    expect(h.api.txRequests[0]).toMatchObject({
      accounts: { payer: feePayer, institution, policy, policyInstitution },
      feePayer,
      computeUnitPrice: '5000',
    });
    expect((body.summary as { requiredSigners: string[] }).requiredSigners).toEqual([feePayer, institution]);
    const missing = await h.call('square_open_job', { ...openArgs(institution), policy: address() });
    expect(missing.body.message).toMatch(/policy .* not found/);
  });

  it('Travel Rule eşiğinde create → commit_travel_rule → fund_job; fonlanmış job için iş yok', async () => {
    h = await connect();
    h.chain.settlementValue.travelRuleThreshold = 1_000_000n;
    const institution = address();
    const created = await h.call('square_open_job', openArgs(institution));
    expect(created.body).toMatchObject({ step: 'createJob', nextStep: 'commitTravelRule' });
    const job = created.body.job as string;
    const onChain = {
      status: 'open' as const,
      institution: new PublicKey(institution),
      agentRecord: new PublicKey(AGENT_RECORD),
      mint: h.chain.settlementValue.mint,
      amount: 5_000_000n,
      travelRuleCommitted: false,
    };
    h.chain.jobs.set(job, onChain);

    const refused = await h.call('square_open_job', openArgs(institution));
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({ error: 'invalid_request', details: { job } });
    expect(refused.body.message).toMatch(/Travel Rule/);

    const commit = await h.call('square_open_job', openArgs(institution, { travelRuleCommitment: hex32(8) }));
    expect(commit.body).toMatchObject({ step: 'commitTravelRule', nextStep: 'fundJob' });
    expect(h.api.txRequests.at(-1)).toMatchObject({
      call: { instruction: 'commitTravelRule', args: { commitment: hex32(8) } },
      accounts: { institution, job },
    });

    h.chain.jobs.set(job, { ...onChain, travelRuleCommitted: true });
    const fund = await h.call('square_open_job', openArgs(institution));
    const ata = getAssociatedTokenAddressSync(
      h.chain.settlementValue.mint,
      new PublicKey(institution),
      true,
      h.chain.settlementValue.tokenProgram,
    ).toBase58();
    expect(fund.body).toMatchObject({ step: 'fundJob', nextStep: null, institutionTokenAccount: ata });
    expect(h.api.txRequests.at(-1)).toMatchObject({
      call: { instruction: 'fundJob', args: {} },
      accounts: {
        institution,
        job,
        institutionTokenAccount: ata,
        tokenProgram: h.chain.settlementValue.tokenProgram.toBase58(),
      },
    });

    h.chain.jobs.set(job, { ...onChain, status: 'funded' });
    const done = await h.call('square_open_job', openArgs(institution));
    expect(done.body).toMatchObject({ step: 'done', status: 'funded' });
    expect(h.chain.sent).toHaveLength(0);
  });

  it('aynı spec farklı koşul ya da başka kurum reddedilir', async () => {
    h = await connect();
    const institution = address();
    const job = h.chain.jobAddress(new PublicKey(institution), Buffer.from(specHash, 'hex')).toBase58();
    const base = {
      status: 'open' as const,
      institution: new PublicKey(institution),
      agentRecord: new PublicKey(AGENT_RECORD),
      mint: h.chain.settlementValue.mint,
      amount: 1n,
      travelRuleCommitted: false,
    };
    h.chain.jobs.set(job, base);
    expect((await h.call('square_open_job', openArgs(institution))).body.message).toMatch(/different terms/);
    h.chain.jobs.set(job, { ...base, institution: Keypair.generate().publicKey });
    expect((await h.call('square_open_job', openArgs(institution))).body.message).toMatch(/another institution/);
  });

  it('kurum yoksa, spec kanonik değilse ya da API simülasyonu düşerse hata', async () => {
    h = await connect();
    const { institution: _omit, ...noInstitution } = openArgs(address());
    void _omit;
    expect((await h.call('square_open_job', noInstitution)).body.message).toMatch(/institution is required/);
    const bad = await h.call('square_open_job', openArgs(address(), { spec: { text: '\ud800' } }));
    expect(bad.body.message).toMatch(/spec is not canonical JSON/);

    h.api.prepare = () => ({
      status: 422,
      error: {
        code: 'simulation_failed',
        message: 'escrow DeadlineInPast (6003)',
        programError: { program: 'escrow', code: 6003, name: 'DeadlineInPast' },
      },
    });
    const failed = await h.call('square_open_job', openArgs(address()));
    expect(failed.body).toMatchObject({
      error: 'square_api_error',
      code: 'simulation_failed',
      programError: { program: 'escrow', code: 6003, name: 'DeadlineInPast' },
    });
  });

  it('API başka fee payer ya da başka program için tx dönerse reddedilir', async () => {
    h = await connect();
    const institution = address();
    const prepared = (feePayer: PublicKey, programId?: PublicKey) => () => ({
      transaction: toBase64(unsignedTx({ feePayer, ...(programId && { programId }) })),
      blockhash: 'x'.repeat(32),
      lastValidBlockHeight: 1,
      feePayer: feePayer.toBase58(),
      signers: [feePayer.toBase58()],
      addressLookupTables: [],
      computeUnitLimit: 1,
      simulatedUnits: null,
    });
    h.api.prepare = prepared(Keypair.generate().publicKey);
    expect((await h.call('square_open_job', openArgs(institution))).body.message).toMatch(/fee payer/);
    h.api.prepare = prepared(new PublicKey(institution), Keypair.generate().publicKey);
    expect((await h.call('square_open_job', openArgs(institution))).body.message).toMatch(/another program/);
  });

  it('API’nin değiştirdiği ya da eklediği talimat reddedilir; yerel imzalayıcı imzalamaz', async () => {
    const keypair = Keypair.generate();
    h = await connect({ signer: LocalSigner.fromKeypair(keypair) });
    const institution = keypair.publicKey.toBase58();
    const honest = h.api.prepare;
    h.api.inject = [
      SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
    ];
    const appended = await h.call('square_open_job', { ...openArgs(institution), sign: true });
    expect(appended.body.message).toMatch(/instruction for another program/);
    h.api.inject = [];
    h.api.prepare = (request) =>
      honest({ ...request, call: { ...request.call, args: { ...request.call.args, amount: '999999999' } as never } });
    const changed = await h.call('square_open_job', { ...openArgs(institution), sign: true });
    expect(changed.body.message).toMatch(/instruction data differs/);
    h.api.prepare = (request) => honest({ ...request, accounts: { ...request.accounts, institution: address() } });
    const swapped = await h.call('square_open_job', { ...openArgs(institution), sign: true });
    expect(swapped.body.message).toMatch(/account institution differs|fee payer/);
    h.api.prepare = honest;
    h.api.inject = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 9_999_999 })];
    const priced = await h.call('square_open_job', { ...openArgs(institution), computeUnitPrice: '5000', sign: true });
    expect(priced.body.message).toMatch(/compute unit price differs/);
    const ceiling = await h.call('square_open_job', { ...openArgs(institution), sign: true });
    expect(ceiling.body.message).toMatch(/above the local signing ceiling/);
    const unsigned = await h.call('square_open_job', openArgs(institution));
    expect(unsigned.body).toMatchObject({ signed: false, submitted: null });
    expect(h.chain.sent).toHaveLength(0);
  });
});

describe('square_accept_job ve square_deliver_work', () => {
  it('funded job için accept_job; durum ve agent cüzdanı denetlenir', async () => {
    h = await connect();
    const agent = address();
    const job = jobView({ status: 'funded', agentWallet: agent, specHash: hex32(6) });
    h.api.jobs.set(job.address, job);
    const { body } = await h.call('square_accept_job', { job: job.address, agent });
    expect(body).toMatchObject({ step: 'acceptJob', job: job.address, signed: false });
    expect(h.api.txRequests[0]).toMatchObject({
      call: { program: 'escrow', instruction: 'acceptJob', args: { specHash: hex32(6) } },
      accounts: { agent, job: job.address },
      feePayer: agent,
    });
    expect((await h.call('square_accept_job', { job: job.address, agent: address() })).body.message).toMatch(
      /bound to agent wallet/,
    );
    expect((await h.call('square_accept_job', { job: address(), agent })).body.message).toMatch(/not found/);
    h.api.jobs.set(job.address, jobView({ address: job.address, status: 'accepted', agentWallet: agent }));
    expect((await h.call('square_accept_job', { job: job.address, agent })).body.message).toMatch(
      /is accepted, expected funded/,
    );
    expect((await h.call('square_accept_job', { job: job.address })).body.message).toMatch(/agent is required/);
  });

  it('içerik API üzerinden yüklenir, submit_work hazırlanır', async () => {
    h = await connect();
    const agent = address();
    const job = jobView({ status: 'accepted', agentWallet: agent });
    h.api.jobs.set(job.address, job);
    const { body } = await h.call('square_deliver_work', {
      job: job.address,
      agent,
      content: 'Çeviri tamam.',
      contentType: 'text/markdown',
    });
    expect(h.api.uploads).toEqual([{ job: job.address, type: 'text/markdown', text: 'Çeviri tamam.' }]);
    const delivery = body.delivery as { workHash: string; deliveryUri: string };
    expect(delivery.workHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.api.txRequests[0]).toMatchObject({
      call: { instruction: 'submitWork', args: { workHash: delivery.workHash, deliveryUri: delivery.deliveryUri } },
      accounts: { agent, job: job.address },
    });
  });

  it('yayımlanmış teslimat; girdi kombinasyonları ve durum denetlenir', async () => {
    h = await connect();
    const agent = address();
    const job = jobView({ status: 'accepted', agentWallet: agent });
    h.api.jobs.set(job.address, job);
    const { body } = await h.call('square_deliver_work', {
      job: job.address,
      agent,
      workHash: hex32(2),
      deliveryUri: 'https://deliveries.example/x',
    });
    expect(body.delivery).toEqual({ workHash: hex32(2), deliveryUri: 'https://deliveries.example/x', size: null });
    expect(h.api.uploads).toHaveLength(0);
    for (const args of [{}, { workHash: hex32(2) }, { content: 'x', workHash: hex32(2), deliveryUri: 'u' }]) {
      const result = await h.call('square_deliver_work', { job: job.address, agent, ...args });
      expect(result.body.message).toMatch(/either content/);
    }
    h.api.jobs.set(job.address, jobView({ address: job.address, status: 'funded', agentWallet: agent }));
    expect((await h.call('square_deliver_work', { job: job.address, agent, content: 'x' })).body.message).toMatch(
      /expected accepted/,
    );
  });
});

describe('square_submit_signed_transaction', () => {
  it('imzasız, kısmen imzalı ve geçersiz imzalı tx hiç gönderilmez', async () => {
    h = await connect();
    const payer = Keypair.generate();
    const other = Keypair.generate();
    const tx = unsignedTx({ feePayer: payer.publicKey, signers: [other.publicKey] });

    const unsigned = await h.call('square_submit_signed_transaction', { transaction: toBase64(tx) });
    expect(unsigned.isError).toBe(true);
    expect(unsigned.body).toMatchObject({
      error: 'not_fully_signed',
      signatures: [
        { signer: payer.publicKey.toBase58(), status: 'missing' },
        { signer: other.publicKey.toBase58(), status: 'missing' },
      ],
    });

    tx.sign([payer]);
    const partial = await h.call('square_submit_signed_transaction', { transaction: toBase64(tx) });
    expect(partial.body).toMatchObject({ error: 'not_fully_signed' });

    // Başka bir mesajın imzası: sıfır değil ama geçersiz.
    const forged = unsignedTx({ feePayer: payer.publicKey, signers: [other.publicKey], blockhash: address() });
    forged.sign([payer, other]);
    tx.signatures[1] = forged.signatures[1]!;
    const invalid = await h.call('square_submit_signed_transaction', { transaction: toBase64(tx) });
    expect(invalid.body).toMatchObject({
      error: 'not_fully_signed',
      signatures: [{ status: 'valid' }, { signer: other.publicKey.toBase58(), status: 'invalid' }],
    });
    expect(h.chain.sent).toHaveLength(0);

    const garbage = await h.call('square_submit_signed_transaction', { transaction: 'not base64!' });
    expect(garbage.body).toMatchObject({ error: 'invalid_request' });
    const truncated = await h.call('square_submit_signed_transaction', { transaction: 'AAAA' });
    expect(truncated.body.message).toMatch(/could not be decoded/);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('tam imzalı tx gönderilir; zincir hatası imzayla döner', async () => {
    h = await connect();
    const payer = Keypair.generate();
    const tx = unsignedTx({ feePayer: payer.publicKey });
    tx.sign([payer]);
    const { isError, body } = await h.call('square_submit_signed_transaction', { transaction: toBase64(tx) });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ network: 'localnet', status: 'confirmed', err: null });
    expect(h.chain.sent).toHaveLength(1);

    h.chain.confirmation = { status: 'confirmed', err: { InstructionError: [1, { Custom: 6001 }] } };
    const failed = await h.call('square_submit_signed_transaction', { transaction: toBase64(tx) });
    expect(failed.isError).toBe(true);
    expect(failed.body).toMatchObject({
      details: { signature: body.signature, err: { InstructionError: [1, { Custom: 6001 }] } },
    });
  });
});

describe('yerel imzalayıcı', () => {
  it('sign: true yerel anahtarla imzalar ve gönderir; cüzdan girdisi varsayılanı imzalayıcıdır', async () => {
    const keypair = Keypair.generate();
    h = await connect({ signer: LocalSigner.fromKeypair(keypair) });
    const job = jobView({ status: 'funded', agentWallet: keypair.publicKey.toBase58() });
    h.api.jobs.set(job.address, job);

    const unsigned = await h.call('square_accept_job', { job: job.address });
    expect(unsigned.body).toMatchObject({ signed: false, submitted: null });
    expect(h.chain.sent).toHaveLength(0);

    const { body } = await h.call('square_accept_job', { job: job.address, sign: true });
    expect(body).toMatchObject({ signed: true, submitted: { status: 'confirmed', err: null } });
    expect(h.chain.sent).toHaveLength(1);
    expect(h.chain.sent[0]!.signatures[0]!.some((b) => b !== 0)).toBe(true);
  });

  it('başka imzacı da gerekiyorsa kısmen imzalı tx döner, gönderilmez', async () => {
    const keypair = Keypair.generate();
    h = await connect({ signer: LocalSigner.fromKeypair(keypair) });
    const job = jobView({ status: 'funded', agentWallet: keypair.publicKey.toBase58() });
    h.api.jobs.set(job.address, job);
    const { body } = await h.call('square_accept_job', { job: job.address, feePayer: address(), sign: true });
    expect(body).toMatchObject({ signed: 'partial', submitted: null });
    const statuses = (body.summary as { signatures: { status: string }[] }).signatures.map((s) => s.status);
    expect(statuses).toEqual(['missing', 'valid']);
    expect(h.chain.sent).toHaveLength(0);
  });

  it('imzalayıcı yapılandırılmamışsa sign: true reddedilir', async () => {
    h = await connect();
    const agent = address();
    const job = jobView({ status: 'funded', agentWallet: agent });
    h.api.jobs.set(job.address, job);
    const { body } = await h.call('square_accept_job', { job: job.address, agent, sign: true });
    expect(body.message).toMatch(/local signer/);
    expect(h.chain.sent).toHaveLength(0);
  });
});
