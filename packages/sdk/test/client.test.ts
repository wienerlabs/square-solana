import { randomBytes } from 'node:crypto';
import { BN, type BorshInstructionCoder, type Idl, type Program } from '@anchor-lang/core';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSquareClient, type SquareClient } from '../src/client.js';
import { specHashing } from '../src/spec.js';
import type { BuiltTx } from '../src/types.js';
import { TestChain } from './helpers/chain.js';
import { createSampler, plain } from './helpers/idl-sample.js';
import { PROGRAM_IDS } from './helpers/ids.js';

const key = () => Keypair.generate().publicKey;
const b58 = (k: PublicKey | null | undefined) => k?.toBase58();

let chain: TestChain;
let client: SquareClient;
const feePayer = key();

const asIdl = (program: unknown) => program as Program<Idl>;

async function setProgramAccount(
  program: Program<Idl>,
  name: string,
  address: PublicKey,
  data: Record<string, unknown>,
) {
  chain.setAccount(address, program.programId, await program.coder.accounts.encode(name, data));
  return address;
}

function decoded(built: BuiltTx, program: Program<Idl>) {
  const message = built.transaction.message;
  const keys = message.staticAccountKeys;
  const all = message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex]!,
    keys: ix.accountKeyIndexes.map((i) => keys[i]!),
    data: Buffer.from(ix.data),
  }));
  const own = all.filter((ix) => ix.programId.equals(program.programId));
  expect(own).toHaveLength(1);
  const ix = own[0]!;
  const { name, data } = (program.coder.instruction as BorshInstructionCoder).decode(ix.data)!;
  const def = program.idl.instructions.find((i) => i.name === name)!;
  const accounts = Object.fromEntries(def.accounts.map((a, i) => [a.name, ix.keys[i]!.toBase58()]));
  return { name, data: plain(data) as Record<string, unknown>, accounts, all };
}

function mint(owner = TOKEN_PROGRAM_ID) {
  const address = key();
  chain.setAccount(address, owner, Buffer.alloc(82));
  return address;
}

async function escrowConfig(settlementMint: PublicKey) {
  const escrow = asIdl(client.escrow.program);
  const data = createSampler(escrow.idl).struct('escrowConfig');
  return setProgramAccount(escrow, 'escrowConfig', client.pda.escrowConfig()[0], { ...data, settlementMint });
}

async function jobAccount(overrides: Record<string, unknown>) {
  const escrow = asIdl(client.escrow.program);
  const data = createSampler(escrow.idl).struct('job');
  const address = key();
  const dispute = { ...(data.dispute as Record<string, unknown>), bond: new BN(0) };
  const account = { ...data, dispute, policy: null, ...overrides };
  await setProgramAccount(escrow, 'job', address, account);
  return {
    address,
    account: account as unknown as Record<string, unknown> & { mint: PublicKey; institution: PublicKey },
  };
}

async function claimListing(job: PublicKey, overrides: Record<string, unknown>) {
  const escrow = asIdl(client.escrow.program);
  const data = createSampler(escrow.idl).struct('claimListing');
  const account = { ...data, job, ...overrides };
  await setProgramAccount(escrow, 'claimListing', client.pda.claimListing(job)[0], account);
  return account as unknown as Record<string, unknown> & { seller: PublicKey; buyer: PublicKey; rentPayer: PublicKey };
}

async function policyAccount(institution: PublicKey) {
  const policy = asIdl(client.policy.program);
  const data = createSampler(policy.idl).struct('policy');
  return setProgramAccount(policy, 'policy', key(), { ...data, institution });
}

const options = () => ({ feePayer });
const escrow = () => asIdl(client.escrow.program);

beforeEach(() => {
  chain = new TestChain();
  client = createSquareClient({ connection: chain.connection(), programIds: PROGRAM_IDS, commitment: 'confirmed' });
});

describe('createSquareClient', () => {
  it('commitment olmadan kurulmaz', () => {
    const connection = { commitment: undefined } as unknown as Connection;
    expect(() => createSquareClient({ connection, programIds: PROGRAM_IDS })).toThrow(/commitment/);
  });

  it('programlar yapılandırmadaki kimliklerle kurulur', () => {
    const programIds = { ...PROGRAM_IDS, escrow: key() };
    const custom = createSquareClient({ connection: chain.connection(), programIds, commitment: 'confirmed' });
    expect(b58(custom.escrow.program.programId)).toBe(b58(programIds.escrow));
    expect(b58(custom.pda.escrowConfig()[0])).toBe(
      b58(PublicKey.findProgramAddressSync([Buffer.from('config')], programIds.escrow)[0]),
    );
  });

  it("IDL instruction builder'ları ve hesap okuma", async () => {
    const job = key();
    const ix = await client.escrow.instructions.listClaim([new BN(5)], {
      payer: feePayer,
      agent: key(),
      job,
      claimListing: client.pda.claimListing(job)[0],
      systemProgram: SystemProgram.programId,
    });
    expect(ix.programId.equals(PROGRAM_IDS.escrow)).toBe(true);
    expect((escrow().coder.instruction as BorshInstructionCoder).decode(ix.data)?.name).toBe('listClaim');
    const { address } = await jobAccount({ mint: key() });
    expect(b58(((await client.escrow.fetch('job', address)) as { mint: PublicKey }).mint)).toBeDefined();
    expect(await client.escrow.fetch('job', key())).toBeNull();
    await expect(client.escrow.fetch('nope' as 'job', key())).rejects.toThrow(/hesap tipi yok/);
  });
});

describe('buildTx', () => {
  it('istenmedikçe compute budget eklemez; blockhash zincirden', async () => {
    const built = await client.buildTx(
      [SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: key(), lamports: 1 })],
      options(),
    );
    expect(built.transaction.message.compiledInstructions).toHaveLength(1);
    expect(built.blockhash).toBe(chain.blockhash);
    expect(built.lastValidBlockHeight).toBe(chain.lastValidBlockHeight);
    expect(built.signers.map(b58)).toEqual([b58(feePayer)]);
  });

  it('compute budget ve ALT ile', async () => {
    const table = key();
    const target = key();
    chain.setLookupTable(table, [target]);
    const signer = key();
    const transfer = SystemProgram.transfer({ fromPubkey: signer, toPubkey: target, lamports: 1 });
    const built = await client.buildTx([transfer], {
      feePayer,
      computeUnitLimit: 300_000,
      computeUnitPrice: 5_000n,
      addressLookupTables: [table],
    });
    const message = built.transaction.message;
    const keys = message.staticAccountKeys;
    expect(
      message.compiledInstructions
        .slice(0, 2)
        .every((ix) => keys[ix.programIdIndex]!.equals(ComputeBudgetProgram.programId)),
    ).toBe(true);
    expect(message.addressTableLookups).toHaveLength(1);
    expect(built.signers.map(b58)).toEqual([b58(feePayer), b58(signer)]);
    await expect(client.buildTx([transfer], { feePayer, addressLookupTables: [key()] })).rejects.toThrow(
      /lookup table/,
    );
  });
});

describe('flow', () => {
  it('registerAgent', async () => {
    const owner = key();
    const wallet = key();
    const hash = randomBytes(32);
    const built = await client.flow.registerAgent(
      { owner, agentId: 'summary-bot', agentCardUri: 'https://a.test/c.json', agentCardHash: hash, wallet },
      options(),
    );
    const ix = decoded(built, asIdl(client.registry.program));
    expect(ix.name).toBe('registerAgent');
    expect(ix.accounts).toMatchObject({ payer: b58(feePayer), owner: b58(owner), agentRecord: b58(built.agentRecord) });
    expect(b58(built.agentRecord)).toBe(b58(client.pda.agentRecord(owner, 'summary-bot')[0]));
    expect(ix.data).toMatchObject({ agentId: 'summary-bot', agentCardHash: Array.from(hash), wallet: b58(wallet) });
    await expect(
      client.flow.registerAgent(
        { owner, agentId: 'x', agentCardUri: 'u', agentCardHash: new Uint8Array(31), wallet },
        options(),
      ),
    ).rejects.toThrow(/32 bayt/);
  });

  it('createJob: politikalı ve politikasız', async () => {
    const institution = key();
    const agentRecord = key();
    const settlement = mint(TOKEN_2022_PROGRAM_ID);
    await escrowConfig(settlement);
    const policyInstitution = key();
    const policy = await policyAccount(policyInstitution);
    const spec = { task: 'çeviri', words: 1200 };
    const built = await client.flow.createJob(
      { institution, agentRecord, policy, spec, amount: 1_000_000n, deadline: 1_790_000_000, challengePeriod: 86_400n },
      options(),
    );
    const ix = decoded(built, escrow());
    expect(ix.name).toBe('createJob');
    expect(built.specHash).toEqual(specHashing.specHash(spec));
    expect(b58(built.job)).toBe(b58(client.pda.job(institution, built.specHash)[0]));
    expect(ix.accounts).toMatchObject({
      payer: b58(feePayer),
      institution: b58(institution),
      agentRecord: b58(agentRecord),
      policy: b58(policy),
      policyInstitution: b58(policyInstitution),
      job: b58(built.job),
      vault: b58(client.pda.vault(built.job)[0]),
      mint: b58(settlement),
      tokenProgram: b58(TOKEN_2022_PROGRAM_ID),
    });
    expect(ix.data).toMatchObject({ amount: '1000000', deadline: '1790000000', challengePeriod: '86400' });

    const open = await client.flow.createJob(
      { institution, agentRecord, spec: { a: 1 }, amount: 1n, deadline: 1, challengePeriod: 1n },
      options(),
    );
    const openIx = decoded(open, escrow());
    expect(openIx.accounts.policy).toBe(b58(PROGRAM_IDS.escrow));
    expect(openIx.accounts.policyInstitution).toBe(b58(PROGRAM_IDS.escrow));
  });

  it('createJob: eksik config / politika, aralık dışı tutar ve token programı olmayan mint reddedilir', async () => {
    const params = {
      institution: key(),
      agentRecord: key(),
      spec: { a: 1 },
      amount: 1n,
      deadline: 1,
      challengePeriod: 1n,
    };
    await expect(client.flow.createJob(params, options())).rejects.toThrow(/config/);
    await escrowConfig(mint(key()));
    await expect(client.flow.createJob(params, options())).rejects.toThrow(/token programına/);
    await escrowConfig(mint());
    await expect(client.flow.createJob({ ...params, policy: key() }, options())).rejects.toThrow(/politika/);
    await expect(client.flow.createJob({ ...params, amount: 2n ** 64n }, options())).rejects.toThrow(/u64/);
    await expect(client.flow.createJob({ ...params, deadline: 2 ** 60 }, options())).rejects.toThrow(/güvenli/);
    await escrowConfig(key());
    await expect(client.flow.createJob(params, options())).rejects.toThrow(/mint bulunamadı/);
  });

  it('fundJob, acceptJob, submitWork', async () => {
    const institution = key();
    const agentWallet = key();
    const agentRecord = key();
    const { address, account } = await jobAccount({ mint: mint(), institution, agentWallet, agentRecord });
    const fund = decoded(
      await client.flow.fundJob({ institution, job: address, institutionTokenAccount: key() }, options()),
      escrow(),
    );
    expect(fund.accounts).toMatchObject({
      institutionScreening: b58(client.pda.screeningRecord(institution)[0]),
      agentScreening: b58(client.pda.screeningRecord(agentWallet)[0]),
      vault: b58(client.pda.vault(address)[0]),
      config: b58(client.pda.escrowConfig()[0]),
      tokenProgram: b58(TOKEN_PROGRAM_ID),
    });
    const agent = key();
    const accept = decoded(await client.flow.acceptJob({ agent, job: address }, options()), escrow());
    expect(accept.accounts).toMatchObject({ agent: b58(agent), job: b58(address), agentRecord: b58(agentRecord) });
    expect(accept.data.specHash).toEqual(plain(account.specHash));
    const workHash = randomBytes(32);
    const submit = decoded(
      await client.flow.submitWork({ agent, job: address, workHash, deliveryUri: 'https://d.test/w' }, options()),
      escrow(),
    );
    expect(submit.data).toMatchObject({ workHash: Array.from(workHash), deliveryUri: 'https://d.test/w' });
    await expect(client.flow.acceptJob({ agent, job: key() }, options())).rejects.toThrow(/job bulunamadı/);
  });

  it('listClaim, buyClaim, cancelClaim', async () => {
    const settlement = mint();
    const policy = key();
    const { address } = await jobAccount({ mint: settlement, policy });
    const agent = key();
    const list = decoded(await client.flow.listClaim({ agent, job: address, price: 900n }, options()), escrow());
    expect(list.accounts).toMatchObject({
      payer: b58(feePayer),
      agent: b58(agent),
      claimListing: b58(client.pda.claimListing(address)[0]),
    });
    await expect(
      client.flow.buyClaim(
        { buyer: key(), job: address, price: 1n, leafSalt: randomBytes(32), merkleProof: [], buyerTokenAccount: key() },
        options(),
      ),
    ).rejects.toThrow(/listelemesi yok/);

    const listing = await claimListing(address, { status: { listed: {} } });
    const buyer = key();
    const proof = [randomBytes(32), randomBytes(32)];
    const buyBuilt = await client.flow.buyClaim(
      { buyer, job: address, price: 900n, leafSalt: randomBytes(32), merkleProof: proof, buyerTokenAccount: key() },
      options(),
    );
    const buy = decoded(buyBuilt, escrow());
    const sellerAta = getAssociatedTokenAddressSync(settlement, listing.seller, true, TOKEN_PROGRAM_ID);
    expect(buy.accounts).toMatchObject({
      buyerScreening: b58(client.pda.screeningRecord(buyer)[0]),
      sellerTokenAccount: b58(sellerAta),
      policy: b58(policy),
    });
    expect(buy.data.merkleProof).toEqual(proof.map((p) => Array.from(p)));
    expect(buy.all).toHaveLength(2);

    const cancel = decoded(
      await client.flow.cancelClaim({ seller: listing.seller, job: address }, options()),
      escrow(),
    );
    expect(cancel.accounts.rentPayer).toBe(b58(listing.rentPayer));
    await expect(client.flow.cancelClaim({ seller: key(), job: key() }, options())).rejects.toThrow(/listelemesi yok/);
  });

  it('finalizePayment: politikasız job, satılmış alacak → payee alıcı', async () => {
    const settlement = mint();
    const { address, account } = await jobAccount({ mint: settlement });
    const listing = await claimListing(address, { status: { bought: {} } });
    const keeper = key();
    const built = await client.flow.finalizePayment({ keeper, job: address, keeperTokenAccount: key() }, options());
    const ix = decoded(built, escrow());
    const payeeAta = getAssociatedTokenAddressSync(settlement, listing.buyer, true, TOKEN_PROGRAM_ID);
    const institutionAta = getAssociatedTokenAddressSync(settlement, account.institution, true, TOKEN_PROGRAM_ID);
    expect(ix.accounts).toMatchObject({
      keeper: b58(keeper),
      payeeTokenAccount: b58(payeeAta),
      institutionTokenAccount: b58(institutionAta),
      payeeScreening: b58(client.pda.screeningRecord(listing.buyer)[0]),
      releaseProof: b58(PROGRAM_IDS.escrow),
      operatorState: b58(PROGRAM_IDS.escrow),
      escrowAuthority: b58(client.pda.escrowAuthority()[0]),
      agentReputation: b58(client.pda.agentReputation(account.agentRecord as PublicKey)[0]),
      validationRecord: b58(client.pda.validationRecord(address)[0]),
      rentPayer: b58(account.rentPayer as PublicKey),
    });
    expect(ix.all).toHaveLength(3);
  });

  it('finalizePayment: politikalı job → ispat kapısı hesapları; listelenmemiş alacak → payee agent', async () => {
    const policyInstitution = key();
    const policy = await policyAccount(policyInstitution);
    const agentWallet = key();
    const { address } = await jobAccount({ mint: mint(), policy, agentWallet });
    const ix = decoded(
      await client.flow.finalizePayment({ keeper: key(), job: address, keeperTokenAccount: key() }, options()),
      escrow(),
    );
    expect(ix.accounts).toMatchObject({
      payeeScreening: b58(client.pda.screeningRecord(agentWallet)[0]),
      releaseProof: b58(client.pda.releaseProof(address)[0]),
      operatorState: b58(client.pda.operatorState(policyInstitution)[0]),
      verifierConfig: b58(client.pda.verifierConfig()[0]),
      verifierProgram: b58(PROGRAM_IDS.verifier),
    });
    const missing = await jobAccount({ mint: mint(), policy: key() });
    await expect(
      client.flow.finalizePayment({ keeper: key(), job: missing.address, keeperTokenAccount: key() }, options()),
    ).rejects.toThrow(/politikası bulunamadı/);
  });

  it('raiseDispute, resolveDispute, executeResolution, cancelJob', async () => {
    const institution = key();
    const { address, account } = await jobAccount({ mint: mint(), institution });
    const raise = decoded(
      await client.flow.raiseDispute(
        { institution, job: address, reasonHash: randomBytes(32), bond: 50n, institutionTokenAccount: key() },
        options(),
      ),
      escrow(),
    );
    expect(raise.accounts).toMatchObject({ bondVault: b58(client.pda.bondVault(address)[0]), payer: b58(feePayer) });
    expect(raise.data.bond).toBe('50');

    const arbitrator = key();
    const resolve = decoded(
      await client.flow.resolveDispute(
        { arbitrator, job: address, resolution: { split: { agentAmount: new BN(10) } } },
        options(),
      ),
      escrow(),
    );
    expect(resolve.data.resolution).toEqual({ split: { agentAmount: '10' } });

    const noBond = decoded(
      await client.flow.executeResolution({ caller: arbitrator, job: address }, options()),
      escrow(),
    );
    expect(noBond.accounts).toMatchObject({
      payer: b58(arbitrator),
      bondVault: b58(PROGRAM_IDS.escrow),
      claimListing: b58(client.pda.claimListing(address)[0]),
    });
    const bonded = await jobAccount({ mint: mint(), dispute: { ...(account.dispute as object), bond: new BN(50) } });
    const withBond = decoded(
      await client.flow.executeResolution({ caller: arbitrator, job: bonded.address }, options()),
      escrow(),
    );
    expect(withBond.accounts.bondVault).toBe(b58(client.pda.bondVault(bonded.address)[0]));

    const cancel = decoded(
      await client.flow.cancelJob({ institution, job: address, institutionTokenAccount: key() }, options()),
      escrow(),
    );
    expect(cancel.accounts).toMatchObject({
      vault: b58(client.pda.vault(address)[0]),
      rentPayer: b58(account.rentPayer as PublicKey),
    });
  });
});
