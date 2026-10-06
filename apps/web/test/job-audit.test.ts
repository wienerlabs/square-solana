// Denetim görünümü (FE-12): API event'lerinin zaman çizelgesine çevrilmesi ve açıklaması, ispat geçmişi,
// explorer bağlantısı. Event'ler API'nin şemasından (`IndexedEventSchema`) geçirilerek kurulur; API yerelde
// dinlenmeyen bir adrestir. Gerçek indexer ve API'ye karşı sayfa PR açıklamasındaki yerel denemededir.
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { IndexedEventSchema, type IndexedEvent } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { explorerTxUrl, proofHistory, readAuditEvents, timelineEntryOf } from '@/lib/job-audit';
import { describeJobEvent } from '@/lib/job-detail';
import { squareApi } from '@/lib/square-api';

const key = () => Keypair.generate().publicKey.toBase58();
const signature = () => bs58.encode(Keypair.generate().secretKey);
const [job, institution, agentRecord, agentWallet, mint, policy, payee] = [
  key(),
  key(),
  key(),
  key(),
  key(),
  key(),
  key(),
];
const NOW = 1_790_000_000;
const usdc = (base: bigint) => `${Number(base) / 1e6} USDC`;

const event = (program: string, name: string, data: Record<string, unknown>, slot = 10): IndexedEvent =>
  IndexedEventSchema.parse({
    signature: signature(),
    slot,
    blockTime: NOW + slot,
    instructionIndex: 0,
    eventIndex: 0,
    payload: { program, name, data },
  });

describe('audit events', () => {
  it('read like the job page timeline', () => {
    const created = timelineEntryOf(
      event('escrow', 'JobCreated', {
        job,
        institution,
        agentRecord,
        agentWallet,
        policy,
        policyVersion: 2,
        mint,
        amount: '250000000',
        specHash: '1'.repeat(64),
        deadline: NOW + 86_400,
        challengePeriod: '600',
      }),
    );
    expect(created.event.data).toMatchObject({ agent_wallet: agentWallet, policy_version: 2, challenge_period: '600' });
    expect(describeJobEvent(created.event, usdc)).toEqual({
      title: 'Job opened',
      detail: `250 USDC for agent wallet ${agentWallet}`,
    });
    const refused = timelineEntryOf(
      event('escrow', 'ReleaseRefused', { job, refusalCode: 8, refundedAmount: '248750000', releaseProof: key() }),
    );
    expect(describeJobEvent(refused.event, usdc)).toEqual({
      title: 'Release refused by the proof',
      detail: '248.75 USDC refunded to the institution: The payee is on the blocked list',
    });
  });

  it('describe the verifier’s proof and release records', () => {
    const proof = (verdict: 'compliant' | 'refused', refusalCode: number) =>
      timelineEntryOf(
        event('verifier', 'ComplianceProofSet', {
          job,
          policy,
          verdict,
          refusalCode,
          payee,
          netAmount: '248750000',
          mint,
          dailySpentBefore: '0',
        }),
      );
    expect(describeJobEvent(proof('compliant', 0).event, usdc)).toEqual({
      title: 'Compliance proof bound: compliant',
      detail: `248.75 USDC to ${payee}`,
    });
    expect(describeJobEvent(proof('refused', 1).event, usdc)).toEqual({
      title: 'Compliance proof bound: refused',
      detail: 'The amount is above the per-transaction limit',
    });
    const recorded = timelineEntryOf(
      event('verifier', 'ReleaseRecorded', {
        job,
        institution,
        netAmount: '248750000',
        dailySpent: '500000000',
        dayStartUnix: NOW,
      }),
    );
    expect(describeJobEvent(recorded.event, usdc)).toEqual({
      title: 'Release recorded by the verifier',
      detail: "248.75 USDC; the institution's daily spend is now 500 USDC",
    });
  });

  it('list every proof bound to the job, oldest first', () => {
    const entries = [
      event(
        'verifier',
        'ComplianceProofSet',
        {
          job,
          policy,
          verdict: 'refused',
          refusalCode: 2,
          payee,
          netAmount: '248750000',
          mint,
          dailySpentBefore: '900000000',
        },
        10,
      ),
      event('escrow', 'JobFunded', { job, amount: '250000000' }, 11),
      event(
        'verifier',
        'ComplianceProofSet',
        {
          job,
          policy,
          verdict: 'compliant',
          refusalCode: 0,
          payee,
          netAmount: '248750000',
          mint,
          dailySpentBefore: '0',
        },
        12,
      ),
    ].map(timelineEntryOf);
    const history = proofHistory(entries);
    expect(history.map((decision) => [decision.compliant, decision.refusalCode, decision.blockTime])).toEqual([
      [false, 2, NOW + 10],
      [true, 0, NOW + 12],
    ]);
    expect(history[1]).toMatchObject({ payee, netAmount: 248_750_000n, signature: entries[2]!.signature });
  });

  it('reports an unreachable API instead of an empty history', async () => {
    await expect(readAuditEvents(squareApi('http://127.0.0.1:9'), job)).rejects.toThrow();
  });
});

describe('explorer links', () => {
  it('name the cluster, and the RPC only on localnet', () => {
    const sig = signature();
    expect(explorerTxUrl(sig, 'devnet', 'https://api.devnet.solana.com')).toBe(
      `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    );
    expect(explorerTxUrl(sig, 'mainnet-beta', 'https://rpc.example')).toBe(`https://explorer.solana.com/tx/${sig}`);
    expect(explorerTxUrl(sig, 'localnet', 'http://127.0.0.1:8899')).toBe(
      `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`,
    );
  });
});
