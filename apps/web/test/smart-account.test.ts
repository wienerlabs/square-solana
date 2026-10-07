// @vitest-environment jsdom
// Smart account (FE-21): hesabın çözülmesi, üyelik kuralları, taslak, seçimin saklanması, öneriler ve sponsorlu tx'in
// compute unit ölçümü. Hesaplar resmi Squads kodlayıcısıyla üretilir (helpers/fake-chain.ts).
import { SQUADS_PROGRAM_ID, SquadsPermission, squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actsAlone,
  checkSmartAccountDraft,
  decodeSmartAccount,
  memberOf,
  permissionNames,
  prepareSponsoredTx,
  proposalAction,
  proposeProblem,
  readProposals,
  readSmartAccount,
  readSmartAccountChoice,
  SimulationError,
  transactionInstructions,
  voters,
  writeSmartAccountChoice,
  type SmartAccountView,
} from '@/lib/smart-account';
import { BLOCKHASH, FakeChain, putMultisig, putProposal } from './helpers/fake-chain';

const { initiate, vote, execute, all } = SquadsPermission;

afterEach(() => window.localStorage.clear());

function account(params: Parameters<typeof putMultisig>[2]) {
  const chain = new FakeChain();
  const multisig = Keypair.generate().publicKey;
  putMultisig(chain, multisig, params);
  return { chain, multisig };
}

describe('smart account', () => {
  it('is read from its Squads v4 multisig account; the vault is vault 0 of the multisig', async () => {
    const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const { chain, multisig } = account({
      members: [
        { key: a, permissions: all },
        { key: b, permissions: vote },
      ],
      threshold: 2,
      timeLock: 30,
      transactionIndex: 7,
      staleTransactionIndex: 4,
    });
    const view = await readSmartAccount(chain.connection, multisig);
    expect(view).toEqual({
      address: multisig.toBase58(),
      vault: squadsVaultAddress(multisig, 0)[0].toBase58(),
      threshold: 2,
      timeLock: 30,
      transactionIndex: 7n,
      staleTransactionIndex: 4n,
      members: [
        { key: a.toBase58(), permissions: all },
        { key: b.toBase58(), permissions: vote },
      ],
    });
    expect(voters(view)).toBe(2);
    expect(permissionNames(all)).toEqual(['Initiate', 'Vote', 'Execute']);
    expect(permissionNames(vote)).toEqual(['Vote']);
    expect(memberOf(view, b.toBase58())?.permissions).toBe(vote);
  });

  it('rejects another program’s account, foreign data and a missing account', async () => {
    const { chain, multisig } = account({ members: [{ key: PublicKey.unique(), permissions: all }], threshold: 1 });
    const data = (await chain.getAccountInfo(multisig))!.data;
    expect(() => decodeSmartAccount(multisig, SystemProgram.programId, data)).toThrow(/not owned by the Squads v4/);
    expect(() => decodeSmartAccount(multisig, SQUADS_PROGRAM_ID, Buffer.alloc(40))).toThrow(/not a Squads v4/);
    await expect(readSmartAccount(chain.connection, PublicKey.unique())).rejects.toThrow(/No smart account/);
  });

  it('lets a member propose with Initiate and act alone only with every permission, threshold 1 and no time lock', () => {
    const me = Keypair.generate().publicKey.toBase58();
    const view = (members: SmartAccountView['members'], threshold = 1, timeLock = 0): SmartAccountView => ({
      address: PublicKey.unique().toBase58(),
      vault: PublicKey.unique().toBase58(),
      threshold,
      timeLock,
      transactionIndex: 0n,
      staleTransactionIndex: 0n,
      members,
    });
    expect(proposeProblem(view([]), me)).toMatch(/not a member/);
    expect(proposeProblem(view([{ key: me, permissions: vote | execute }]), me)).toMatch(/lacks Initiate/);
    expect(proposeProblem(view([{ key: me, permissions: initiate }]), me)).toBeNull();
    expect(actsAlone(view([{ key: me, permissions: all }]), me)).toBe(true);
    expect(actsAlone(view([{ key: me, permissions: initiate | vote }]), me)).toBe(false);
    expect(actsAlone(view([{ key: me, permissions: all }], 2), me)).toBe(false);
    expect(actsAlone(view([{ key: me, permissions: all }], 1, 60), me)).toBe(false);
  });
});

describe('draft', () => {
  const me = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();

  it('makes this wallet and the listed wallets members with every permission', () => {
    expect(checkSmartAccountDraft(me, { others: '', threshold: '1' })).toEqual({
      ok: true,
      members: [{ key: me, permissions: all }],
      threshold: 1,
    });
    expect(checkSmartAccountDraft(me, { others: ` ${other}\n`, threshold: '2' })).toMatchObject({
      ok: true,
      members: [{ key: me }, { key: other }],
      threshold: 2,
    });
  });

  it('rejects an address that is not one, a repeated member and a threshold out of range', () => {
    expect(checkSmartAccountDraft(me, { others: 'abc', threshold: '1' })).toEqual({
      ok: false,
      error: 'abc is not a Solana address.',
    });
    expect(checkSmartAccountDraft(me, { others: me, threshold: '1' })).toEqual({
      ok: false,
      error: 'A member is listed twice.',
    });
    expect(checkSmartAccountDraft(me, { others: '', threshold: '0' })).toMatchObject({ ok: false });
    expect(checkSmartAccountDraft(me, { others: '', threshold: '1.5' })).toMatchObject({ ok: false });
    expect(checkSmartAccountDraft(me, { others: other, threshold: '3' })).toEqual({
      ok: false,
      error: 'The threshold is at most the number of members (2).',
    });
  });
});

describe('choice', () => {
  it('is kept per wallet and role in this browser; a stored value that is not an address is ignored', () => {
    const [wallet, multisig] = [PublicKey.unique().toBase58(), PublicKey.unique().toBase58()];
    expect(readSmartAccountChoice(wallet, 'agent')).toBeNull();
    writeSmartAccountChoice(wallet, 'agent', multisig);
    expect(readSmartAccountChoice(wallet, 'agent')).toBe(multisig);
    expect(readSmartAccountChoice(wallet, 'institution')).toBeNull();
    writeSmartAccountChoice(wallet, 'agent', null);
    expect(readSmartAccountChoice(wallet, 'agent')).toBeNull();
    window.localStorage.setItem(`square-smart-account:${wallet}:buyer`, 'not-an-address');
    expect(readSmartAccountChoice(wallet, 'buyer')).toBeNull();
  });
});

describe('proposals', () => {
  it('are read newest first; closed ones drop out, stale ones are marked and show their programs', async () => {
    const [me, other] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const { chain, multisig } = account({
      members: [
        { key: me, permissions: all },
        { key: other, permissions: all },
      ],
      threshold: 2,
      transactionIndex: 4,
      staleTransactionIndex: 2,
    });
    const vault = squadsVaultAddress(multisig, 0)[0];
    const program = PublicKey.unique();
    putProposal(chain, multisig, 4, { status: { __kind: 'Active', timestamp: 100 }, approved: [me], program, vault });
    putProposal(chain, multisig, 3, { status: { __kind: 'Executed', timestamp: 90 }, approved: [me, other] });
    putProposal(chain, multisig, 2, { status: { __kind: 'Active', timestamp: 80 } });
    const view = await readSmartAccount(chain.connection, multisig);
    const proposals = await readProposals(chain.connection, view);
    expect(proposals.map((p) => [p.index, p.status, p.stale, p.approved.length])).toEqual([
      [4n, 'active', false, 1],
      [3n, 'executed', false, 2],
      [2n, 'active', true, 0],
    ]);
    expect(proposals[0]!.programs).toEqual([program.toBase58()]);
    expect(proposals[0]!.statusAt).toBe(100);
    expect(proposals[1]!.programs).toBeNull();
  });

  it('offer approval to a voting member who has not voted and execution after approval and the time lock', () => {
    const me = Keypair.generate().publicKey.toBase58();
    const base: SmartAccountView = {
      address: PublicKey.unique().toBase58(),
      vault: PublicKey.unique().toBase58(),
      threshold: 2,
      timeLock: 60,
      transactionIndex: 5n,
      staleTransactionIndex: 1n,
      members: [{ key: me, permissions: all }],
    };
    const proposal = (status: 'active' | 'approved', extra: object = {}) => ({
      index: 5n,
      status,
      statusAt: 1_000,
      approved: [],
      rejected: [],
      cancelled: [],
      programs: null,
      stale: false,
      ...extra,
    });
    expect(proposalAction(base, proposal('active'), me, 0)).toBe('approve');
    expect(proposalAction(base, proposal('active', { approved: [me] }), me, 0)).toBeNull();
    expect(proposalAction(base, proposal('approved'), me, 1_059)).toBeNull();
    expect(proposalAction(base, proposal('approved'), me, 1_060)).toBe('execute');
    expect(proposalAction(base, proposal('approved', { stale: true }), me, 2_000)).toBeNull();
    expect(proposalAction(base, proposal('active'), PublicKey.unique().toBase58(), 0)).toBeNull();
    const voteOnly = { ...base, members: [{ key: me, permissions: vote }] };
    expect(proposalAction(voteOnly, proposal('approved'), me, 2_000)).toBeNull();
  });
});

describe('sponsored transaction', () => {
  const sponsor = Keypair.generate().publicKey;
  const transfer = SystemProgram.transfer({
    fromPubkey: Keypair.generate().publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  });
  const limitOf = (transaction: VersionedTransaction) => {
    const [first] = TransactionMessage.decompile(transaction.message).instructions;
    expect(first!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    return first!.data.readUInt32LE(1);
  };

  it('is paid by the sponsor and its compute limit is the simulated use with a 20% margin', async () => {
    const chain = new FakeChain();
    chain.simulations.push({ err: null, logs: [], unitsConsumed: 100_000 });
    const prepared = await prepareSponsoredTx(chain.connection, {
      sponsor,
      instructions: [transfer],
      maxComputeUnits: 1_400_000,
    });
    expect(prepared.transaction.message.staticAccountKeys[0]!.equals(sponsor)).toBe(true);
    expect(prepared.transaction.message.recentBlockhash).toBe(BLOCKHASH);
    expect(limitOf(prepared.transaction)).toBe(120_000);
    // Ölçüm tx'i protokolün tavanıyla simüle edilir.
    expect(limitOf(chain.simulated[0]!)).toBe(1_400_000);
  });

  it('is refused when the sponsor’s limit is too low, when simulation fails or when it does not fit', async () => {
    const chain = new FakeChain();
    chain.simulations.push({ err: null, logs: [], unitsConsumed: 900_000 });
    await expect(
      prepareSponsoredTx(chain.connection, { sponsor, instructions: [transfer], maxComputeUnits: 1_000_000 }),
    ).rejects.toThrow(/needs about 1080000 compute units; the sponsor pays for at most 1000000/);
    chain.simulations.push({ err: { InstructionError: [1, { Custom: 6000 }] }, logs: ['failed'], unitsConsumed: 1 });
    const failure = await prepareSponsoredTx(chain.connection, {
      sponsor,
      instructions: [transfer],
      maxComputeUnits: 1_400_000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SimulationError);
    expect((failure as SimulationError).logs).toEqual(['failed']);
    const huge = new Array(40)
      .fill(0)
      .map(() => SystemProgram.transfer({ fromPubkey: sponsor, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    await expect(
      prepareSponsoredTx(chain.connection, { sponsor, instructions: huge, maxComputeUnits: 1_400_000 }),
    ).rejects.toThrow(/does not fit in a packet/);
  });

  it('keeps the instructions of a built transaction without its compute budget', async () => {
    const chain = new FakeChain();
    const built = new VersionedTransaction(
      new TransactionMessage({
        payerKey: sponsor,
        recentBlockhash: BLOCKHASH,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }), transfer],
      }).compileToV0Message(),
    );
    const instructions = await transactionInstructions(chain.connection, built);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.programId.equals(SystemProgram.programId)).toBe(true);
  });
});
