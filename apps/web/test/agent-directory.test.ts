// Agent dizini ve profili (FE-05): beceri fiyatı, fiyat ve itibar filtresi, sıralama, ağ ve registry
// denetimi, validation geçmişi. Agent görünümleri API'nin şemasından (`AgentViewSchema`) geçirilerek kurulur;
// API yerelde dinlenmeyen bir adrestir. Gerçek indexer ve API'ye karşı dizin PR açıklamasındaki yerel denemededir.
import { Keypair, PublicKey } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import { AGENT_CARD_TYPE, AgentViewSchema, JobViewSchema, type AgentView, type JobView } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import {
  directoryRows,
  parseCount,
  priceOf,
  readAgentProfile,
  readDirectory,
  sameNetwork,
  validationHistory,
} from '@/lib/agent-directory';
import { squareApi } from '@/lib/square-api';

const key = () => Keypair.generate().publicKey.toBase58();
const CHAIN_REF = key().slice(0, 32);
const REGISTRY = key();
const USDC = key();
const NOW = 1_790_000_000;

const card = (skills: { id: string; tags: string[]; price?: string; mint?: string }[], agentRecord: string) => ({
  type: AGENT_CARD_TYPE,
  name: `Agent ${agentRecord.slice(0, 4)}`,
  description: 'Writes research reports.',
  url: 'https://agent.example/a2a',
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['application/pdf'],
  skills: skills.map(({ id, tags }) => ({ id, name: id, description: `${id} skill`, tags })),
  services: [{ name: 'A2A', endpoint: 'https://agent.example/a2a' }],
  registrations: [{ agentRegistry: `solana:${CHAIN_REF}:${REGISTRY}`, agentId: agentRecord }],
  pricing: skills.flatMap(({ id, price, mint }) => (price ? [{ skillId: id, amount: price, mint: mint ?? USDC }] : [])),
});

const agent = (fields: {
  skills?: { id: string; tags: string[]; price?: string; mint?: string }[] | null;
  completed?: string;
  earned?: string;
  registeredAt?: number;
  chainRef?: string;
  registry?: string;
}): AgentView => {
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
      registeredAt: fields.registeredAt ?? NOW,
      updatedAt: fields.registeredAt ?? NOW,
      bump: 255,
      agentId: `agent-${address.slice(0, 6)}`,
      agentCardUri: '',
    },
    did: squareIdentity.formatDidAip({
      chainRef: fields.chainRef ?? CHAIN_REF,
      registry: new PublicKey(fields.registry ?? REGISTRY),
      agentRecord: new PublicKey(address),
    }),
    card: fields.skills === null ? null : card(fields.skills ?? [{ id: 'research', tags: [] }], address),
    cardVerified: true,
    reputation:
      fields.completed === undefined
        ? null
        : {
            agentRecord: address,
            jobsCompleted: fields.completed,
            jobsFailed: '0',
            jobsDisputed: '0',
            totalEarned: fields.earned ?? '0',
            firstJobAt: NOW,
            lastJobAt: NOW,
            bump: 254,
          },
    slot: 100,
    indexedAt: NOW,
  });
};

describe('agent prices', () => {
  it('take the lowest price in the settlement mint, for the skill searched', () => {
    const { card: listed } = agent({
      skills: [
        { id: 'research', tags: ['reports'], price: '25000000' },
        { id: 'translation', tags: ['reports'], price: '10000000' },
        { id: 'audit', tags: [], price: '5000000', mint: key() },
      ],
    });
    expect(priceOf(listed, null, USDC)).toBe(10_000_000n);
    expect(priceOf(listed, 'research', USDC)).toBe(25_000_000n);
    expect(priceOf(listed, 'reports', USDC)).toBe(10_000_000n);
    // Başka mint'teki fiyat karşılaştırılmaz; fiyatı olmayan beceri ve kart null.
    expect(priceOf(listed, 'audit', USDC)).toBeNull();
    expect(priceOf(listed, 'design', USDC)).toBeNull();
    expect(priceOf(null, null, USDC)).toBeNull();
  });
});

describe('directory rows', () => {
  const cheap = agent({ skills: [{ id: 'research', tags: [], price: '5000000' }], completed: '2', earned: '9' });
  const busy = agent({
    skills: [{ id: 'research', tags: [], price: '20000000' }],
    completed: '7',
    registeredAt: NOW - 60,
  });
  const fresh = agent({ skills: [{ id: 'research', tags: [] }], registeredAt: NOW + 60 });
  const tied = agent({ skills: [{ id: 'research', tags: [], price: '20000000' }], completed: '2', earned: '30' });
  const all = [cheap, busy, fresh, tied];
  const rows = (params: Partial<Parameters<typeof directoryRows>[1]>) =>
    directoryRows(all, {
      skill: null,
      maxPrice: null,
      minCompleted: null,
      sort: 'completed',
      mint: USDC,
      ...params,
    }).map((row) => row.agent);

  it('filter by price and completed jobs', () => {
    expect(rows({ maxPrice: 10_000_000n })).toEqual([cheap]);
    // Fiyat sınırı varken fiyatı olmayan agent görünmez; sınır yokken görünür.
    expect(rows({ maxPrice: 20_000_000n })).not.toContain(fresh);
    expect(rows({})).toContain(fresh);
    expect(rows({ minCompleted: 3n })).toEqual([busy]);
    expect(rows({ minCompleted: 0n })).toHaveLength(4);
    // Mint bilinmiyorsa fiyat karşılaştırılmaz.
    expect(
      directoryRows(all, { skill: null, maxPrice: 10_000_000n, minCompleted: null, sort: 'price', mint: null }),
    ).toEqual([]);
  });

  it('sort by completed jobs, price or registration', () => {
    expect(rows({ sort: 'completed' })).toEqual([busy, tied, cheap, fresh]);
    expect(rows({ sort: 'price' }).slice(0, 1)).toEqual([cheap]);
    expect(rows({ sort: 'price' }).at(-1)).toBe(fresh);
    expect(rows({ sort: 'newest' })[0]).toBe(fresh);
    expect(rows({ sort: 'newest' })[3]).toBe(busy);
  });

  it('reads the completed-jobs filter as a whole number', () => {
    expect(parseCount('3')).toEqual({ ok: true, value: 3n });
    expect(parseCount('0')).toEqual({ ok: true, value: 0n });
    for (const text of ['-1', '1.5', '03', 'two']) expect(parseCount(text).ok).toBe(false);
  });
});

describe('network', () => {
  it('shows only agents of this chain and registry', () => {
    const expected = { chainRef: CHAIN_REF, registry: REGISTRY };
    expect(sameNetwork(agent({}), expected)).toBe(true);
    expect(sameNetwork(agent({ chainRef: key().slice(0, 32) }), expected)).toBe(false);
    expect(sameNetwork(agent({ registry: key() }), expected)).toBe(false);
    // Registry yapılandırılmamışsa yalnızca zincir karşılaştırılır.
    expect(sameNetwork(agent({ registry: key() }), { chainRef: CHAIN_REF, registry: null })).toBe(true);
    expect(sameNetwork({ ...agent({}), did: 'did:web:agent.example' }, expected)).toBe(false);
  });
});

describe('profile', () => {
  const job = (address: string, validation: { outcome: string; recordedAt: number } | null): JobView => {
    const wallet = key();
    return JobViewSchema.parse({
      address,
      account: {
        institution: key(),
        agentRecord: key(),
        agentWallet: wallet,
        mint: USDC,
        rentPayer: key(),
        amount: '250000000',
        specHash: '1'.repeat(64),
        status: validation ? 'released' : 'delivered',
        createdAt: NOW,
        fundedAt: NOW,
        deadline: NOW + 86_400,
        challengePeriod: '600',
        challengeEnd: NOW + 600,
        deliveredAt: NOW,
        settledAt: validation ? validation.recordedAt : 0,
        workHash: '2'.repeat(64),
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
        deliveryUri: 'https://deliveries.example/report',
      },
      payee: wallet,
      claim: null,
      releaseProof: null,
      validation: validation && {
        job: address,
        agentRecord: key(),
        outcome: validation.outcome,
        refusalCode: validation.outcome === 'refused' ? 8 : 0,
        recordedAt: validation.recordedAt,
        bump: 253,
        policy: null,
        releaseProof: null,
      },
      slot: 100,
      indexedAt: NOW,
    });
  };

  it('lists the settled jobs’ validation records, newest first', () => {
    const [a, b, c] = [key(), key(), key()];
    const history = validationHistory([
      job(a, { outcome: 'noGate', recordedAt: NOW + 10 }),
      job(b, null),
      job(c, { outcome: 'refused', recordedAt: NOW + 20 }),
    ]);
    expect(history.map((entry) => [entry.job, entry.record.outcome])).toEqual([
      [c, 'refused'],
      [a, 'noGate'],
    ]);
  });

  it('reports an unreachable API instead of an empty directory or profile', async () => {
    const api = squareApi('http://127.0.0.1:9');
    await expect(readDirectory(api, { skill: null, includeInactive: false })).rejects.toThrow();
    await expect(readAgentProfile(api, key())).rejects.toThrow();
  });
});
