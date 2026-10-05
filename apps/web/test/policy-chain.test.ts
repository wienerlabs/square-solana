// Politikanın zincir tarafı (FE-04): commit planı, square_policy talimatlarının kodlaması ve hesap
// sırası, işlem loglarından geçmiş. Ağ kullanılmaz: talimatlar ve event'ler square_policy IDL'iyle
// kodlanıp çözülür. Gerçek programa karşı akış PR açıklamasındaki yerel validator denemesindedir.
import { BorshCoder, BorshInstructionCoder, type Idl } from '@anchor-lang/core';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { institutionAddress, policyAddress } from '@/lib/idl-pda';
import {
  institutionNameProblem,
  planPolicyCommit,
  policyCommitInstructions,
  policyErrorMessage,
  policyEventsFromLogs,
  type CommitTarget,
  type PolicyChainState,
} from '@/lib/policy-chain';

const key = () => Keypair.generate().publicKey;
const programId = key();
const owner = key();
const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);
const ZERO = new Uint8Array(32);

const target = (overrides: Partial<CommitTarget> = {}): CommitTarget => ({
  commitment: bytes32(7),
  dailyCeiling: 1_000_000_000n,
  buyerRoot: bytes32(9),
  institutionName: 'Acme Research',
  ...overrides,
});

const institution = (multisigVault: PublicKey | null = null): PolicyChainState['institution'] => ({
  ownerKey: owner,
  name: 'Acme Research',
  policyCount: 1,
  multisigVault,
});

const policy = (overrides: Partial<NonNullable<PolicyChainState['policy']>> = {}): PolicyChainState['policy'] => ({
  commitment: bytes32(7),
  dailyCeiling: 1_000_000_000n,
  buyerRoot: bytes32(9),
  version: 1,
  active: true,
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_000,
  ...overrides,
});

describe('commit plan', () => {
  it('opens the institution and commits a new policy in one transaction', () => {
    expect(planPolicyCommit({ institution: null, policy: null }, target())).toEqual({
      state: 'ready',
      steps: ['initInstitution', 'setPolicy', 'setBuyerRoot'],
    });
    // set_policy kökü sıfırla açar: boş alıcı listesi ayrı bir talimat gerektirmez.
    expect(planPolicyCommit({ institution: institution(), policy: null }, target({ buyerRoot: ZERO }))).toEqual({
      state: 'ready',
      steps: ['setPolicy'],
    });
  });

  it('updates only what differs from the chain', () => {
    const chain = { institution: institution(), policy: policy() };
    expect(planPolicyCommit(chain, target())).toEqual({ state: 'unchanged' });
    expect(planPolicyCommit(chain, target({ commitment: bytes32(8) }))).toEqual({
      state: 'ready',
      steps: ['updatePolicy'],
    });
    expect(planPolicyCommit(chain, target({ dailyCeiling: 2_000_000_000n }))).toEqual({
      state: 'ready',
      steps: ['updatePolicy'],
    });
    expect(planPolicyCommit(chain, target({ buyerRoot: bytes32(10) }))).toEqual({
      state: 'ready',
      steps: ['setBuyerRoot'],
    });
    // Var olan politikada listeyi boşaltmak sıfır kökü yayımlamaktır.
    expect(planPolicyCommit(chain, target({ buyerRoot: ZERO }))).toEqual({ state: 'ready', steps: ['setBuyerRoot'] });
  });

  it('refuses what the program would reject', () => {
    expect(planPolicyCommit({ institution: null, policy: null }, target({ dailyCeiling: 0n }))).toEqual({
      state: 'blocked',
      reason: 'The public daily ceiling must be greater than zero.',
    });
    expect(planPolicyCommit({ institution: null, policy: null }, target({ institutionName: ' ' }))).toEqual({
      state: 'blocked',
      reason: 'Name the institution.',
    });
    expect(
      planPolicyCommit(
        { institution: institution(), policy: policy({ active: false }) },
        target({ commitment: bytes32(8) }),
      ),
    ).toEqual({ state: 'blocked', reason: 'This policy is deactivated on chain. Start a new policy instead.' });
    const vault = key();
    expect(
      planPolicyCommit({ institution: institution(vault), policy: policy() }, target({ commitment: bytes32(8) })),
    ).toEqual({
      state: 'blocked',
      reason: `This institution is controlled by its Squads multisig (vault ${vault.toBase58()}). Commit through Squads.`,
    });
  });

  it('checks the institution name against the 64-byte limit', () => {
    expect(institutionNameProblem('Acme Research')).toBeNull();
    expect(institutionNameProblem('x'.repeat(64))).toBeNull();
    expect(institutionNameProblem('x'.repeat(65))).toBe('The name is at most 64 bytes.');
    // Bayt sayılır: 32 adet iki baytlık harf 64 bayttır.
    expect(institutionNameProblem('ğ'.repeat(32))).toBeNull();
    expect(institutionNameProblem('ğ'.repeat(33))).toBe('The name is at most 64 bytes.');
  });
});

describe('square_policy instructions', () => {
  // Bağlantı yalnızca Anchor sağlayıcısı içindir; talimatlar kurulurken ağa gidilmez.
  const connection = new Connection('http://127.0.0.1:9');
  const coder = new BorshInstructionCoder(SQUARE_IDLS.policy as unknown as Idl);
  const policyId = bytes32(3);
  const inst = institutionAddress(programId, owner);
  const pol = policyAddress(programId, inst, policyId);
  const flags = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);

  it('encodes every step with the contract arguments and account order', async () => {
    const [init, set, update, root] = await policyCommitInstructions(connection, {
      programId,
      owner,
      policyId,
      steps: ['initInstitution', 'setPolicy', 'updatePolicy', 'setBuyerRoot'],
      target: target(),
    });
    for (const ix of [init, set, update, root]) expect(ix!.programId.equals(programId)).toBe(true);

    expect(coder.decode(Buffer.from(init!.data))).toEqual({
      name: 'init_institution',
      data: { name: 'Acme Research' },
    });
    expect(flags(init!)).toEqual([
      [owner.toBase58(), true, true],
      [owner.toBase58(), true, false],
      [inst.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]);

    const decodedSet = coder.decode(Buffer.from(set!.data))!;
    expect(decodedSet.name).toBe('set_policy');
    const setData = decodedSet.data as { policy_id: number[]; commitment: number[]; daily_ceiling: BN };
    expect(setData.policy_id).toEqual(Array.from(policyId));
    expect(setData.commitment).toEqual(Array.from(bytes32(7)));
    expect(setData.daily_ceiling.toString()).toBe('1000000000');
    expect(flags(set!)).toEqual([
      [owner.toBase58(), true, true],
      [owner.toBase58(), true, false],
      [inst.toBase58(), false, true],
      [pol.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]);

    expect(coder.decode(Buffer.from(update!.data))?.name).toBe('update_policy');
    expect(flags(update!)).toEqual([
      [owner.toBase58(), true, false],
      [inst.toBase58(), false, false],
      [pol.toBase58(), false, true],
    ]);

    const decodedRoot = coder.decode(Buffer.from(root!.data))!;
    expect(decodedRoot).toEqual({ name: 'set_buyer_root', data: { buyer_root: Array.from(bytes32(9)) } });
    expect(flags(root!)).toEqual(flags(update!));
  });

  it('names the policy error behind a custom program error', () => {
    const entry = (SQUARE_IDLS.policy.errors as readonly { code: number; name: string; msg: string }[]).find(
      (e) => e.code === 6003,
    )!;
    expect(policyErrorMessage(new Error('custom program error: 0x1773'))).toBe(`${entry.msg} (${entry.name}, 6003)`);
    expect(policyErrorMessage(new Error('Blockhash not found'))).toBeNull();
  });
});

describe('history from transaction logs', () => {
  const coder = new BorshCoder(SQUARE_IDLS.policy as unknown as Idl);
  const events = SQUARE_IDLS.policy.events as readonly { name: string; discriminator: number[] }[];
  const programData = (name: string, data: Record<string, unknown>) => {
    const discriminator = events.find((e) => e.name === name)!.discriminator;
    const body = coder.types.encode(name, data);
    return `Program data: ${Buffer.concat([Buffer.from(discriminator), body]).toString('base64')}`;
  };
  const invocation = (program: PublicKey, lines: string[]) => [
    `Program ${program.toBase58()} invoke [1]`,
    ...lines,
    `Program ${program.toBase58()} consumed 14000 of 200000 compute units`,
    `Program ${program.toBase58()} success`,
  ];
  const mine = key();
  const other = key();

  it('reads the events of this policy only', () => {
    const logs = [
      ...invocation(programId, [
        programData('PolicyCommitted', {
          policy: mine,
          institution: key(),
          policy_id: Array.from(bytes32(3)),
          commitment: Array.from(bytes32(7)),
          daily_ceiling: new BN('1000000000'),
          version: 1,
        }),
        programData('BuyerRootCommitted', { policy: mine, buyer_root: Array.from(bytes32(9)) }),
        programData('BuyerRootCommitted', { policy: other, buyer_root: Array.from(bytes32(1)) }),
      ]),
      // Başka bir programın aynı biçimdeki logu sayılmaz.
      ...invocation(key(), [programData('PolicyDeactivated', { policy: mine })]),
      ...invocation(programId, [
        programData('PolicyUpdated', {
          policy: mine,
          commitment: Array.from(bytes32(8)),
          daily_ceiling: new BN('2000000000'),
          version: 2,
        }),
        programData('PolicyDeactivated', { policy: mine }),
      ]),
    ];
    expect(policyEventsFromLogs(programId, logs, mine)).toEqual([
      { kind: 'committed', version: 1, commitment: bytes32(7), dailyCeiling: 1_000_000_000n },
      { kind: 'buyerRoot', buyerRoot: bytes32(9) },
      { kind: 'updated', version: 2, commitment: bytes32(8), dailyCeiling: 2_000_000_000n },
      { kind: 'deactivated' },
    ]);
    expect(policyEventsFromLogs(programId, logs, other)).toEqual([{ kind: 'buyerRoot', buyerRoot: bytes32(1) }]);
  });
});
