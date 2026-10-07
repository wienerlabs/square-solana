// Rol panelleri (FE-11): işlerin durum sayıları ve tutarları, günlük tavan kullanımı (UTC günü), agent'ın kazancı,
// alıcının alacakları. Görünümler API'nin şemalarından (`JobViewSchema`, `PolicyViewSchema`, `AgentViewSchema`,
// `ClaimViewSchema`) geçirilerek kurulur; API yerelde dinlenmeyen bir adrestir. Gerçek indexer ve API'ye karşı
// paneller PR açıklamasındaki yerel denemededir.
import { Keypair, PublicKey } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import { releaseNetAmount, SECONDS_PER_DAY } from '@squaresdk/solana-policy';
import {
  AgentViewSchema,
  ClaimViewSchema,
  JobViewSchema,
  PolicyViewSchema,
  type ClaimStatus,
  type JobStatus,
  type JobView,
} from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import {
  agentEarnings,
  buyerTotals,
  dailyUsage,
  jobTotals,
  percentOf,
  readAgentOverview,
  readBuyerClaims,
  readListing,
} from '@/lib/dashboards';
import { squareApi } from '@/lib/square-api';

const key = () => Keypair.generate().publicKey.toBase58();
const USDC = key();
const NOW = 1_790_000_000;
const KEEPER_FEE_BPS = 50;

const claimListing = (job: string, status: ClaimStatus, price: string, faceValue: string) => ({
  job,
  seller: key(),
  buyer: status === 'listed' ? PublicKey.default.toBase58() : key(),
  rentPayer: key(),
  price,
  faceValue,
  listedAt: NOW,
  boughtAt: status === 'listed' ? 0 : NOW + 60,
  status,
  bump: 252,
});

const job = (
  status: JobStatus,
  amount: string,
  fields: {
    mint?: string;
    claim?: { status: ClaimStatus; price: string };
    createdAt?: number;
    rail?: 'escrow' | 'fiat';
  } = {},
): JobView => {
  const address = key();
  const wallet = key();
  return JobViewSchema.parse({
    address,
    account: {
      institution: key(),
      agentRecord: key(),
      agentWallet: wallet,
      mint: fields.mint ?? USDC,
      rentPayer: key(),
      amount,
      specHash: '1'.repeat(64),
      status,
      createdAt: fields.createdAt ?? NOW,
      fundedAt: status === 'open' ? 0 : NOW,
      deadline: NOW + 86_400,
      challengePeriod: '600',
      challengeEnd: NOW + 600,
      deliveredAt: 0,
      settledAt: 0,
      workHash: '0'.repeat(64),
      travelRuleCommitment: '0'.repeat(64),
      policyCommitment: '0'.repeat(64),
      policyDailyCeiling: '0',
      policyVersion: 0,
      bump: 255,
      vaultBump: 254,
      bondBump: 253,
      policy: null,
      // Uyuşmazlık açılmamış işin alanı: escrow'un sıfır değerleri.
      dispute: {
        challenger: PublicKey.default.toBase58(),
        bond: '0',
        reasonHash: '0'.repeat(64),
        raisedAt: 0,
        deadline: 0,
        decidedAt: 0,
        closedAt: 0,
        lapsed: false,
        approvalMask: 0,
        approvalCount: 0,
        arbitratorSetVersion: 0,
        resolution: { kind: 'pending' },
      },
      deliveryUri: '',
      rail: fields.rail ?? 'escrow',
    },
    payee: wallet,
    claim: fields.claim ? claimListing(address, fields.claim.status, fields.claim.price, amount) : null,
    releaseProof: null,
    validation: null,
    slot: 100,
    indexedAt: NOW,
  });
};

const policy = (active: boolean, dailyCeiling: string, name: string | null) =>
  PolicyViewSchema.parse({
    address: key(),
    account: {
      institution: key(),
      policyId: 'a'.repeat(64),
      commitment: 'b'.repeat(64),
      dailyCeiling,
      buyerRoot: '0'.repeat(64),
      version: 3,
      active,
      createdAt: NOW,
      updatedAt: NOW,
      bump: 251,
    },
    meta: name && { name, description: null, labels: [], updatedAt: NOW },
    slot: 100,
    indexedAt: NOW,
  });

describe('job totals', () => {
  it('count every status and sum the escrowed and released amounts in the settlement mint', () => {
    const totals = jobTotals(
      [
        job('open', '10000000'),
        job('funded', '250000000'),
        job('delivered', '100000000'),
        job('disputed', '50000000'),
        job('released', '400000000'),
        job('refunded', '70000000'),
        job('funded', '999000000', { mint: key() }),
      ],
      USDC,
    );
    expect(totals.counts).toMatchObject({ open: 1, funded: 2, delivered: 1, disputed: 1, released: 1, refunded: 1 });
    expect(totals.escrowed).toBe(400_000_000n);
    expect(totals.released).toBe(400_000_000n);
    expect(totals.otherMint).toBe(1);
    expect(totals.fiat).toEqual({ jobs: 0, awaitingPayment: 0, released: 0, paid: 0n });
  });

  it('keep fiat jobs out of the escrow: nothing is locked, the institution pays by card', () => {
    const totals = jobTotals(
      [
        job('funded', '250000000'),
        job('accepted', '125000000', { rail: 'fiat' }),
        job('delivered', '75000000', { rail: 'fiat' }),
        job('released', '50000000', { rail: 'fiat' }),
        job('released', '400000000'),
      ],
      USDC,
    );
    expect(totals.escrowed).toBe(250_000_000n);
    expect(totals.released).toBe(400_000_000n);
    expect(totals.counts).toMatchObject({ funded: 1, accepted: 0, delivered: 0, released: 1 });
    expect(totals.fiat).toEqual({ jobs: 3, awaitingPayment: 1, released: 1, paid: 50_000_000n });
  });
});

describe('daily ceiling', () => {
  const day = NOW - (NOW % SECONDS_PER_DAY);
  const policies = [
    policy(true, '1000000000', 'Treasury'),
    policy(false, '5000000000', 'Old version'),
    policy(true, '200000000', null),
  ];

  it('uses the counter of the current UTC day against each active policy', () => {
    const usage = dailyUsage({ dayStartUnix: day, dailySpent: 250_000_000n }, NOW, policies);
    expect(usage.spent).toBe(250_000_000n);
    expect(usage.resetsAt).toBe(day + SECONDS_PER_DAY);
    expect(usage.ceilings.map((ceiling) => [ceiling.name, ceiling.ceiling, ceiling.remaining])).toEqual([
      ['Treasury', 1_000_000_000n, 750_000_000n],
      [null, 200_000_000n, 0n],
    ]);
  });

  it('starts from zero on a new day and before the first release', () => {
    expect(dailyUsage({ dayStartUnix: day - SECONDS_PER_DAY, dailySpent: 900_000_000n }, NOW, policies).spent).toBe(0n);
    expect(dailyUsage(null, NOW, policies).spent).toBe(0n);
  });

  it('does not guess a counter that belongs to a later day than the chain clock', () => {
    const usage = dailyUsage({ dayStartUnix: day + SECONDS_PER_DAY, dailySpent: 1n }, NOW, policies);
    expect(usage.spent).toBeNull();
    expect(usage.ceilings.every((ceiling) => ceiling.remaining === null)).toBe(true);
  });

  it('reads the share in hundredths of a percent, rounded down', () => {
    expect(percentOf(250_000_000n, 1_000_000_000n)).toBe('25%');
    expect(percentOf(1n, 8n)).toBe('12.5%');
    expect(percentOf(2n, 3n)).toBe('66.66%');
    expect(percentOf(3n, 2n)).toBe('150%');
  });
});

describe('agent earnings', () => {
  const view = (totalEarned: string | null) => {
    const address = key();
    const wallet = key();
    return AgentViewSchema.parse({
      address,
      account: {
        creator: wallet,
        owner: wallet,
        wallet,
        agentCardHash: '0'.repeat(64),
        status: 'active',
        registeredAt: NOW,
        updatedAt: NOW,
        bump: 255,
        agentId: 'orbit',
        agentCardUri: '',
      },
      did: squareIdentity.formatDidAip({
        chainRef: key().slice(0, 32),
        registry: new PublicKey(key()),
        agentRecord: new PublicKey(address),
      }),
      card: null,
      cardVerified: false,
      reputation: totalEarned && {
        agentRecord: address,
        jobsCompleted: '2',
        jobsFailed: '0',
        jobsDisputed: '0',
        totalEarned,
        firstJobAt: NOW,
        lastJobAt: NOW,
        bump: 254,
      },
      slot: 100,
      indexedAt: NOW,
    });
  };

  it('separate what was released, what was sold and what still waits in escrow', () => {
    const jobs = [
      job('funded', '100000000'),
      job('delivered', '200000000', { claim: { status: 'listed', price: '180000000' } }),
      job('delivered', '300000000', { claim: { status: 'bought', price: '270000000' } }),
      job('released', '400000000', { claim: { status: 'settled', price: '360000000' } }),
      job('disputed', '500000000'),
      job('accepted', '700000000', { mint: key() }),
    ];
    const earnings = agentEarnings(view('646500000'), jobs, KEEPER_FEE_BPS, USDC);
    expect(earnings.released).toBe(646_500_000n);
    expect(earnings.sold).toEqual({ count: 2, price: 630_000_000n });
    // Satılmamış (listelenmiş olan dahil) ve dispute'suz iki iş; net keeper ücreti düşülmüş hâli.
    expect(earnings.pending).toEqual({
      count: 2,
      net: releaseNetAmount(100_000_000n, KEEPER_FEE_BPS) + releaseNetAmount(200_000_000n, KEEPER_FEE_BPS),
    });
  });

  it('are zero before the first settled job', () => {
    expect(agentEarnings(view(null), [], KEEPER_FEE_BPS, USDC)).toEqual({
      released: 0n,
      sold: { count: 0, price: 0n },
      pending: { count: 0, net: 0n },
      fiat: { count: 0, amount: 0n },
    });
  });

  it('count released fiat jobs apart and never as USDC on its way to the agent wallet', () => {
    const jobs = [
      job('delivered', '100000000', { rail: 'fiat' }),
      job('released', '60000000', { rail: 'fiat' }),
      job('delivered', '200000000'),
    ];
    const earnings = agentEarnings(view('60000000'), jobs, KEEPER_FEE_BPS, USDC);
    expect(earnings.fiat).toEqual({ count: 1, amount: 60_000_000n });
    expect(earnings.pending).toEqual({ count: 1, net: releaseNetAmount(200_000_000n, KEEPER_FEE_BPS) });
  });
});

describe('buyer receivables', () => {
  const claim = (status: ClaimStatus, price: string, faceValue: string) => {
    const jobAddress = key();
    return ClaimViewSchema.parse({
      address: key(),
      job: jobAddress,
      account: claimListing(jobAddress, status, price, faceValue),
      slot: 100,
      indexedAt: NOW,
    });
  };

  it('total each state and the net still to be paid at release', () => {
    const totals = buyerTotals(
      [
        claim('bought', '225000000', '250000000'),
        claim('bought', '90000000', '100000000'),
        claim('settled', '45000000', '50000000'),
        claim('defaulted', '18000000', '20000000'),
      ],
      KEEPER_FEE_BPS,
    );
    expect(totals.bought).toEqual({ count: 2, price: 315_000_000n, faceValue: 350_000_000n });
    expect(totals.settled).toEqual({ count: 1, price: 45_000_000n, faceValue: 50_000_000n });
    expect(totals.defaulted).toEqual({ count: 1, price: 18_000_000n, faceValue: 20_000_000n });
    expect(totals.expectedPayout).toBe(
      releaseNetAmount(250_000_000n, KEEPER_FEE_BPS) + releaseNetAmount(100_000_000n, KEEPER_FEE_BPS),
    );
  });
});

describe('panel reads', () => {
  it('report an unreachable API instead of empty panels', async () => {
    const api = squareApi('http://127.0.0.1:9');
    await expect(readListing((window) => api.listJobs({ institution: key(), ...window }))).rejects.toThrow();
    await expect(readAgentOverview(api, key(), { chainRef: key().slice(0, 32), registry: null })).rejects.toThrow();
    await expect(readBuyerClaims(api, key())).rejects.toThrow();
  });
});
