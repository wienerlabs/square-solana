// Uyuşmazlık kuralları (FE-17): minimum bond (Rust birim testinin vektörleri), son tarih ve geri sayım, oy
// sayımı ve set değişimi, düğme koşulları, kararın ödenişi, lapse bilgisi, hata açıklamaları ve zaman
// çizelgesindeki dispute event'leri. Ağ kullanılmaz: hesaplar ve event'ler escrow IDL'iyle kodlanır.
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import {
  describeResolution,
  disputeErrorMessage,
  disputeFacts,
  disputeParamsOf,
  disputePhase,
  escalationState,
  lapseNotice,
  minimumBond,
  proofSettlesToday,
  raiseState,
  resolutionOf,
  sameResolution,
  settlementOf,
  toAnchorResolution,
  voteBlock,
  voteChoices,
  voteTally,
  type DisputeParams,
} from '@/lib/dispute';
import { describeJobEvent, jobEventsFromLogs } from '@/lib/job-detail';
import { coder, configAccount, jobAccount, key } from './helpers/escrow-accounts';

const usdc = (base: bigint) => `${Number(base) / 1_000_000} USDC`;
const [institution, agent, mint] = [key(), key(), key()];
const arbitrators = [key(), key(), key()];
const RAISED = 1_790_008_000;
const DEADLINE = RAISED + 259_200;

const params = async (fields: { version?: number; threshold?: number } = {}): Promise<DisputeParams> =>
  disputeParamsOf(
    await configAccount({
      arbitrators,
      threshold: fields.threshold ?? 2,
      arbitrator_set_version: fields.version ?? 0,
    }),
  );

const disputed = (dispute: Parameters<typeof jobAccount>[0]['dispute'] = {}, status = 'disputed') =>
  jobAccount({
    institution,
    agent_wallet: agent,
    mint,
    status,
    dispute: { challenger: institution, bond: 12_500_000, raised_at: RAISED, deadline: DEADLINE, ...dispute },
  });

describe('bond', () => {
  it('is the larger of the relative and the absolute minimum, as on chain', () => {
    // programs/square-escrow/src/dispute.rs: bond_is_the_larger_of_the_relative_and_absolute_minimum
    const rule = { minBondBps: 500, minBondAbsolute: 1_000n };
    expect(minimumBond(10_000n, rule)).toBe(1_000n);
    expect(minimumBond(1_000_000n, rule)).toBe(50_000n);
    expect(minimumBond(2n ** 64n - 1n, rule)).toBe((2n ** 64n - 1n) / 20n);
    // Bond sıfır olamaz: iki alt sınır da sıfırsa en az 1.
    expect(minimumBond(10n, { minBondBps: 0, minBondAbsolute: 0n })).toBe(1n);
  });

  it('reads the rule and the panel from the escrow config', async () => {
    const config = await configAccount({ arbitrators, threshold: 2, arbitrator_set_version: 4, min_bond_bps: 250 });
    const read = disputeParamsOf(config);
    expect(read).toMatchObject({
      minBondBps: 250,
      minBondAbsolute: 1_000_000n,
      disputeTimeoutSecs: 259_200,
      proofTimeoutSecs: 86_400,
      threshold: 2,
      arbitratorSetVersion: 4,
    });
    // Boş slotlar set değildir.
    expect(read.arbitrators.map((a) => a.toBase58())).toEqual(arbitrators.map((a) => a.toBase58()));
  });
});

describe('resolution', () => {
  it('reads both the program’s and the event decoder’s enum shapes', () => {
    expect(resolutionOf({ favorAgent: {} })).toEqual({ kind: 'favorAgent' });
    expect(resolutionOf({ FavorInstitution: {} })).toEqual({ kind: 'favorInstitution' });
    expect(resolutionOf({ split: { agentAmount: new BN(7) } })).toEqual({ kind: 'split', agentAmount: '7' });
    expect(resolutionOf({ Split: { agent_amount: new BN(9) } })).toEqual({ kind: 'split', agentAmount: '9' });
    expect(() => resolutionOf({ Unknown: {} })).toThrow();
    const split = toAnchorResolution({ kind: 'split', agentAmount: '100' });
    expect(split.split?.agentAmount.toString()).toBe('100');
    expect(resolutionOf(toAnchorResolution({ kind: 'favorAgent' }))).toEqual({ kind: 'favorAgent' });
    expect(sameResolution({ kind: 'split', agentAmount: '1' }, { kind: 'split', agentAmount: '2' })).toBe(false);
  });

  it('pays the decision like execute_resolution', () => {
    expect(settlementOf({ kind: 'favorAgent' }, 100n, 5n)).toEqual({
      agentSide: 100n,
      institutionRefund: 0n,
      bondToAgentSide: 5n,
      bondReturned: 0n,
    });
    expect(settlementOf({ kind: 'favorInstitution' }, 100n, 5n)).toMatchObject({
      institutionRefund: 100n,
      bondReturned: 5n,
    });
    expect(settlementOf({ kind: 'split', agentAmount: '30' }, 100n, 5n)).toEqual({
      agentSide: 30n,
      institutionRefund: 70n,
      bondToAgentSide: 0n,
      bondReturned: 5n,
    });
    expect(() => settlementOf({ kind: 'split', agentAmount: '101' }, 100n, 5n)).toThrow();
    expect(describeResolution({ kind: 'split', agentAmount: '30000000' }, usdc)).toBe(
      'Split: 30 USDC to the agent, the rest back to the institution',
    );
  });
});

describe('dispute phase', () => {
  it('counts down to the deadline in chain time and then can be lapsed', async () => {
    const facts = disputeFacts(await disputed());
    expect(disputePhase(facts, 'disputed', DEADLINE - 90)).toEqual({
      phase: 'open',
      remaining: 90,
      deadline: DEADLINE,
    });
    expect(disputePhase(facts, 'disputed', null)).toEqual({ phase: 'open', remaining: null, deadline: DEADLINE });
    // `lapse_dispute` son tarihte ve sonrasında: `now >= deadline`.
    expect(disputePhase(facts, 'disputed', DEADLINE)).toEqual({ phase: 'expired', deadline: DEADLINE });
  });

  it('tells decided, lapsed and closed disputes apart', async () => {
    const none = disputeFacts(await jobAccount({ institution, agent_wallet: agent, mint }));
    expect(disputePhase(none, 'delivered', 1)).toEqual({ phase: 'none' });
    const decided = disputeFacts(
      await disputed({ decided_at: RAISED + 10, resolution: { FavorAgent: {} } }, 'resolved'),
    );
    expect(disputePhase(decided, 'resolved', DEADLINE + 1)).toEqual({ phase: 'decided', decidedAt: RAISED + 10 });
    const lapsed = disputeFacts(await disputed({ lapsed: true, closed_at: DEADLINE + 5 }, 'delivered'));
    expect(disputePhase(lapsed, 'delivered', DEADLINE + 6)).toEqual({ phase: 'lapsed', closedAt: DEADLINE + 5 });
    // Lapse sonrası iş normal yolundan kapandı: kayıt yine lapse'tır.
    expect(disputePhase(lapsed, 'released', DEADLINE + 6).phase).toBe('lapsed');
    const closed = disputeFacts(
      await disputed({ closed_at: DEADLINE - 5, resolution: { FavorInstitution: {} } }, 'refunded'),
    );
    expect(disputePhase(closed, 'refunded', DEADLINE)).toEqual({ phase: 'closed', closedAt: DEADLINE - 5 });
  });

  it('says the bond was refunded when the dispute lapsed', async () => {
    const lapsed = disputeFacts(await disputed({ lapsed: true, closed_at: DEADLINE }, 'delivered'));
    expect(lapseNotice(lapsed, usdc)).toBe(
      'The dispute lapsed without a decision: the bond of 12.5 USDC was refunded to the institution. The job went back to Delivered and settles through finalize_payment.',
    );
    const escalation = disputeFacts(await disputed({ challenger: agent, bond: 0, lapsed: true }, 'delivered'));
    expect(lapseNotice(escalation, usdc)).toMatch(/no bond to refund/);
  });
});

describe('votes', () => {
  it('counts the approvals towards M and fixes the decision after the first vote', async () => {
    const p = await params();
    const facts = disputeFacts(
      await disputed({ approval_mask: 0b001, approval_count: 1, resolution: { Split: { agent_amount: new BN(40) } } }),
    );
    const tally = voteTally(facts, p);
    expect(tally).toMatchObject({ approvals: 1, threshold: 2, stale: false, voted: [true, false, false] });
    expect(voteChoices(tally)).toEqual({ kind: 'fixed', resolution: { kind: 'split', agentAmount: '40' } });
    expect(voteChoices(voteTally(disputeFacts(await disputed()), p))).toEqual({ kind: 'any' });
  });

  it('drops the count of an older arbitrator set (ADR 0016 §2)', async () => {
    const facts = disputeFacts(
      await disputed({
        approval_mask: 0b001,
        approval_count: 1,
        resolution: { FavorAgent: {} },
        arbitrator_set_version: 0,
      }),
    );
    const tally = voteTally(facts, await params({ version: 1 }));
    expect(tally).toMatchObject({
      approvals: 0,
      stale: true,
      decision: { kind: 'pending' },
      voted: [false, false, false],
    });
    expect(voteChoices(tally)).toEqual({ kind: 'any' });
  });

  it('closes the vote to outsiders, after the deadline and after voting', async () => {
    const p = await params();
    const facts = disputeFacts(
      await disputed({ approval_mask: 0b010, approval_count: 1, resolution: { FavorAgent: {} } }),
    );
    const block = (arbitrator: PublicKey, chainNow: number | null, status = 'disputed') =>
      voteBlock({ status, facts, disputeParams: p, arbitrator, chainNow });
    expect(block(arbitrators[0]!, DEADLINE - 1)).toBeNull();
    expect(block(key(), DEADLINE - 1)).toMatch(/not in the escrow’s active arbitrator set/);
    expect(block(arbitrators[1]!, DEADLINE - 1)).toMatch(/already voted/);
    // `resolve_dispute` yalnızca `now < deadline` iken.
    expect(block(arbitrators[0]!, DEADLINE)).toMatch(/deadline has passed/);
    expect(block(arbitrators[0]!, DEADLINE - 1, 'resolved')).toMatch(/no longer open/);
    expect(block(arbitrators[0]!, null)).toMatch(/chain clock/);
  });
});

describe('who can act', () => {
  it('lets the institution dispute once, inside the challenge window', async () => {
    const fresh = disputeFacts(await jobAccount({ institution, agent_wallet: agent, mint }));
    expect(raiseState({ status: 'delivered', challengeEnd: 1_000, facts: fresh, chainNow: 400 })).toEqual({
      ok: true,
      remaining: 600,
      challengeEnd: 1_000,
    });
    expect(raiseState({ status: 'delivered', challengeEnd: 1_000, facts: fresh, chainNow: 1_000 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/challenge window has closed/),
    });
    const lapsed = disputeFacts(await disputed({ lapsed: true }, 'delivered'));
    expect(raiseState({ status: 'delivered', challengeEnd: 1_000, facts: lapsed, chainNow: 400 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already had a dispute, which lapsed/),
    });
  });

  it('lets the agent escalate a missing proof after the waiting period', async () => {
    const fresh = disputeFacts(await jobAccount({ institution, agent_wallet: agent, mint }));
    const state = (facts: typeof fresh, chainNow: number, extra: Partial<Parameters<typeof escalationState>[0]> = {}) =>
      escalationState({
        status: 'delivered',
        hasPolicy: true,
        challengeEnd: 1_000,
        facts,
        proofTimeoutSecs: 500,
        chainNow,
        proofSettles: false,
        ...extra,
      });
    expect(state(fresh, 1_200)).toEqual({ state: 'waiting', readyAt: 1_500, remaining: 300 });
    expect(state(fresh, 1_500)).toEqual({ state: 'ready' });
    expect(state(fresh, 1_500, { proofSettles: true })).toEqual({ state: 'proofSettles' });
    expect(state(fresh, 1_500, { hasPolicy: false })).toEqual({ state: 'notApplicable' });
    // Lapse'tan sonra bekleme dispute'un kapanışından sayılır.
    const lapsed = disputeFacts(await disputed({ lapsed: true, closed_at: 5_000 }, 'delivered'));
    expect(state(lapsed, 5_100)).toEqual({ state: 'waiting', readyAt: 5_500, remaining: 400 });
    const open = disputeFacts(await disputed());
    expect(state(open, 9_999_999_999, { status: 'disputed' })).toEqual({ state: 'notApplicable' });
  });

  it('knows when a bound proof settles the job today', () => {
    const day = 1_790_000_000 - (1_790_000_000 % 86_400);
    const proof = { consumed: false, proofTimestamp: day + 10, compliant: true, refusalCode: 0, dailySpentBefore: 0n };
    expect(proofSettlesToday(proof, day + 80_000)).toBe(true);
    expect(proofSettlesToday(proof, day + 86_400)).toBe(false); // ertesi UTC günü: bayat
    expect(proofSettlesToday({ ...proof, consumed: true }, day + 20)).toBe(false);
    expect(proofSettlesToday({ ...proof, compliant: false, refusalCode: 1 }, day + 20)).toBe(true); // kesin ret
    expect(proofSettlesToday({ ...proof, compliant: false, refusalCode: 2, dailySpentBefore: 5n }, day + 20)).toBe(
      false,
    );
    expect(proofSettlesToday(null, day)).toBe(false);
  });
});

describe('program errors', () => {
  const code = (name: string) => SQUARE_IDLS.escrow.errors.find((e) => e.name === name)!.code;
  const fail = (name: string) => new Error(`custom program error: 0x${code(name).toString(16)}`);

  it('explains every dispute error with what to do', () => {
    for (const name of [
      'InsufficientBond',
      'DisputeWindowClosed',
      'DisputeAlreadyRaised',
      'NotArbitrator',
      'AlreadyVoted',
      'ResolutionMismatch',
      'DisputeNotExpired',
      'ProofTimeoutNotReached',
      'InvalidDisputeTimeout',
      'ProofRequired',
    ]) {
      const message = disputeErrorMessage(fail(name))!;
      expect(message, name).toContain(`(${name}, ${code(name)}). `);
    }
    expect(disputeErrorMessage(fail('InsufficientBond'))).toBe(
      'Insufficient dispute bond provided (InsufficientBond, 6022). The bond must be at least max(amount × min_bond_bps / 10 000, min_bond_absolute) from the escrow config, and above zero.',
    );
    expect(disputeErrorMessage(new Error('blockhash not found'))).toBeNull();
  });
});

describe('dispute events in the timeline', () => {
  const escrow = key();
  const job = key();
  const events = SQUARE_IDLS.escrow.events as readonly { name: string; discriminator: number[] }[];
  const describe = (name: string, data: Record<string, unknown>) => {
    const discriminator = events.find((e) => e.name === name)!.discriminator;
    const encoded = Buffer.concat([Buffer.from(discriminator), coder.types.encode(name, { job, ...data })]);
    const logs = [
      `Program ${escrow.toBase58()} invoke [1]`,
      `Program data: ${encoded.toString('base64')}`,
      `Program ${escrow.toBase58()} success`,
    ];
    return describeJobEvent(jobEventsFromLogs(escrow, logs, job)[0]!, usdc);
  };

  it('shows votes, decisions, payouts and the lapse', () => {
    const arbitrator = key();
    expect(describe('DisputeVote', { arbitrator, resolution: { FavorAgent: {} }, approval_count: 1 })).toEqual({
      title: 'Arbitrator vote',
      detail: `${arbitrator.toBase58()}: In favor of the agent; 1 approval(s) in the count`,
    });
    expect(describe('DisputeDecided', { resolution: { Split: { agent_amount: new BN(5_000_000) } } })).toEqual({
      title: 'Dispute decided',
      detail: 'Split: 5 USDC to the agent, the rest back to the institution',
    });
    expect(
      describe('DisputeResolved', {
        resolution: { FavorInstitution: {} },
        agent_side_amount: new BN(0),
        institution_refund: new BN(250_000_000),
        bond_to_agent_side: new BN(0),
        bond_returned: new BN(12_500_000),
      }).detail,
    ).toBe(
      '0 USDC to the agent side, 250 USDC back to the institution; bond 0 USDC to the agent side, 12.5 USDC returned',
    );
    expect(describe('DisputeLapsed', { bond_refunded: new BN(12_500_000) })).toEqual({
      title: 'Dispute lapsed',
      detail: 'No decision by the deadline: bond 12.5 USDC refunded to the institution; the job is back to Delivered',
    });
    expect(describe('MissingProofEscalated', { agent_wallet: agent }).detail).toBe(
      `by the agent wallet ${agent.toBase58()}, without a bond`,
    );
    expect(
      describe('DisputeRaised', {
        challenger: institution,
        bond: new BN(12_500_000),
        reason_hash: Array(32).fill(3),
        deadline: new BN(DEADLINE),
      }).detail,
    ).toBe(
      `by ${institution.toBase58()}, bond 12.5 USDC, deadline ${new Date(DEADLINE * 1000).toISOString().replace('.000', '')}`,
    );
  });
});
