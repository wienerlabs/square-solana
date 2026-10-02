// 8 adımlı "mandate'ten ödemeye" senaryosu (analiz §4.2) ve ret / bekletme varyantları. Her (varyant,
// adım) çifti için zincir ve indexer görünümünün tam bir anlık görüntüsünü üretir. Değerler BC-44
// IDL'inden üretilen şemalara ve BE-35 görünümlerine uyar (test: test/contract.test.mjs).
import type {
  AgentCard,
  AgentView,
  ClaimView,
  DisputeView,
  IndexedEvent,
  InstitutionView,
  JobView,
  KeeperAction,
  PolicyView,
  ProgramEventPayload,
  ScreeningView,
} from '@squaresdk/solana-types';
import { ZERO_ADDRESS, ZERO_HEX32, mockAddress, mockHex32, mockSignature } from './ids.js';

export const SCENARIO_STEPS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type ScenarioStep = (typeof SCENARIO_STEPS)[number];

export const SCENARIO_VARIANTS = ['happy', 'proofPending', 'releaseRefused', 'screeningFlagged'] as const;
export type ScenarioVariant = (typeof SCENARIO_VARIANTS)[number];

export type ScenarioRole = 'institution' | 'agent' | 'buyer' | 'keeper';

/** Senaryonun 4 rolü ve imzalayan cüzdanları. */
export const ROLES: Record<ScenarioRole, { label: string; wallet: string }> = {
  institution: { label: 'Kurum', wallet: mockAddress('role:institution') },
  agent: { label: 'Agent', wallet: mockAddress('role:agent') },
  buyer: { label: 'Alıcı', wallet: mockAddress('role:buyer') },
  keeper: { label: 'Keeper', wallet: mockAddress('role:keeper') },
};

/** Adımlar; sıra ve içerik analiz §4.2 ile BE-35 sözleşmesi §6'daki tablodan. */
export const STEPS: Record<ScenarioStep, { role: ScenarioRole; title: string }> = {
  1: { role: 'institution', title: 'Politika commitment\'ı ve public günlük tavan' },
  2: { role: 'agent', title: 'Agent kaydı (did:aip)' },
  3: { role: 'institution', title: 'Screening, iş açma ve fonlama' },
  4: { role: 'agent', title: 'Kabul ve teslim; challenge penceresi açılır' },
  5: { role: 'buyer', title: 'Alacağın onaylı alıcıya satışı' },
  6: { role: 'keeper', title: 'Permissionless finalize denemesi' },
  7: { role: 'institution', title: 'Release ispatının job\'a bağlanması' },
  8: { role: 'keeper', title: 'Ödeme, itibar ve validation kaydı' },
};

export const VARIANTS: Record<ScenarioVariant, { title: string; description: string; lastStep: ScenarioStep }> = {
  happy: {
    title: 'Mutlu yol',
    description: 'İspat mandate\'e uyar; ödeme alacağı satın alan alıcıya gider, itibar agent\'a yazılır.',
    lastStep: 8,
  },
  proofPending: {
    title: 'Bekletme: ispat yok',
    description: 'Kurum ispatı bağlamaz; keeper her denemede ProofRequired ile bekler, escrow kilitli kalır.',
    lastStep: 6,
  },
  releaseRefused: {
    title: 'Ret: mandate reddediyor',
    description: 'Bağlanan ispatın kararı refused; para kuruma iade edilir, sebep zincire yazılır, alacak defaulted olur.',
    lastStep: 8,
  },
  screeningFlagged: {
    title: 'Ret: screening',
    description: 'Agent cüzdanı sanctions screening\'de flagged; fonlama ScreeningFlagged ile reddedilir, iş open kalır.',
    lastStep: 3,
  },
};

// ---------------------------------------------------------------- sabitler

/** Senaryonun tüm adreslerinin etiketleri; program ID'leri sahte, BC-09'un ID'leri değil. */
export const MOCK_IDS = {
  registryProgram: mockAddress('program:registry'),
  institution: mockAddress('pda:institution'),
  policy: mockAddress('pda:policy'),
  agentRecord: mockAddress('pda:agent-record'),
  job: mockAddress('pda:job'),
  claim: mockAddress('pda:claim'),
  releaseProof: mockAddress('pda:release-proof'),
  agentOwner: ROLES.agent.wallet,
  agentWallet: ROLES.agent.wallet,
} as const;

/** Devnet USDC mint'i. */
export const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
/** CAIP-2 devnet referansı (did:aip v2 Solana profili, BC-14). */
export const DEVNET_CHAIN_REF = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const AMOUNT = 250_000_000n; // 250 USDC (6 ondalık)
const KEEPER_FEE_BPS = 50n;
const KEEPER_FEE = (AMOUNT * KEEPER_FEE_BPS) / 10_000n; // BC-44 §6: her dalda ödenir
const NET = AMOUNT - KEEPER_FEE;
const CLAIM_PRICE = 240_000_000n;
const DAILY_CEILING = 1_000_000_000_000n;
const CHALLENGE_PERIOD = 86_400;
const REFUSAL_CODE = 2; // örnek ret kodu; anlamı devrenin kural numaralandırmasında (BC-19)

const T0 = 1_790_000_000;
/** Her adımın zincir zamanı (unix saniyesi). Challenge penceresi 4. adımda açılır, 24 saat sürer. */
export const STEP_TIME: Record<ScenarioStep, number> = {
  1: T0,
  2: T0 + 600,
  3: T0 + 1_200,
  4: T0 + 3_600,
  5: T0 + 7_200,
  6: T0 + 3_600 + CHALLENGE_PERIOD + 60,
  7: T0 + 3_600 + CHALLENGE_PERIOD + 600,
  8: T0 + 3_600 + CHALLENGE_PERIOD + 900,
};
const CHALLENGE_END = STEP_TIME[4] + CHALLENGE_PERIOD;
const SLOT0 = 400_000_000;
const slotAt = (step: ScenarioStep) => SLOT0 + step * 1_000;

export const DID = `did:aip:solana:${DEVNET_CHAIN_REF}:${MOCK_IDS.registryProgram}:${MOCK_IDS.agentRecord}`;

export const AGENT_CARD: AgentCard = {
  name: 'Scribe',
  description: 'Belgeleri özetler ve taslak hazırlar.',
  url: 'https://scribe.agents.example/a2a',
  version: '1.0.0',
  provider: { organization: 'Scribe Labs', url: 'https://scribe.agents.example' },
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/markdown'],
  skills: [
    {
      id: 'summarize',
      name: 'Belge özetleme',
      description: 'Uzun belgelerden yapılandırılmış özet üretir.',
      tags: ['summarization'],
    },
  ],
  registrations: [{ agentRegistry: `solana:${DEVNET_CHAIN_REF}:${MOCK_IDS.registryProgram}`, agentId: MOCK_IDS.agentRecord }],
  pricing: [{ skillId: 'summarize', amount: AMOUNT.toString(), mint: USDC_DEVNET }],
};

export const AGENT_CARD_URI = `https://mock.square.example/a/${MOCK_IDS.agentRecord}/.well-known/agent-card.json`;

// ---------------------------------------------------------------- dünya

export interface MockWorld {
  variant: ScenarioVariant;
  /** İstenen adım. */
  step: ScenarioStep;
  /** Durumun gerçekten ulaştığı adım (varyant erken durursa küçüktür). */
  reachedStep: ScenarioStep;
  /** Senaryo saati (unix saniyesi); görünümlerin `indexedAt`'i. */
  now: number;
  slot: number;
  institutions: InstitutionView[];
  policies: PolicyView[];
  agents: AgentView[];
  screenings: ScreeningView[];
  jobs: JobView[];
  claims: ClaimView[];
  disputes: DisputeView[];
  events: IndexedEvent[];
  keeperActions: KeeperAction[];
}

type JobAccount = JobView['account'];
type ClaimAccount = NonNullable<JobView['claim']>;
type ReleaseProofAccount = NonNullable<JobView['releaseProof']>;
type ValidationAccount = NonNullable<JobView['validation']>;
type AgentAccount = AgentView['account'];
type Reputation = NonNullable<AgentView['reputation']>;
type ScreeningAccount = ScreeningView['account'];

interface State {
  institution: InstitutionView['account'] | null;
  policy: PolicyView['account'] | null;
  policyMeta: PolicyView['meta'];
  agent: AgentAccount | null;
  reputation: Reputation | null;
  screenings: Map<string, ScreeningAccount>;
  job: JobAccount | null;
  claim: ClaimAccount | null;
  releaseProof: ReleaseProofAccount | null;
  validation: ValidationAccount | null;
  events: IndexedEvent[];
  keeperActions: KeeperAction[];
}

const DEFAULT_DISPUTE: JobAccount['dispute'] = {
  challenger: ZERO_ADDRESS,
  bond: '0',
  reasonHash: ZERO_HEX32,
  raisedAt: 0,
  deadline: 0,
  decidedAt: 0,
  closedAt: 0,
  lapsed: false,
  approvalMask: 0,
  approvalCount: 0,
  arbitratorSetVersion: 0,
  resolution: { kind: 'pending' },
};

function emit(s: State, step: ScenarioStep, payload: ProgramEventPayload): void {
  const n = s.events.filter((e) => e.slot === slotAt(step)).length;
  s.events.push({
    signature: mockSignature(`event:${step}:${n}:${payload.name}`),
    slot: slotAt(step),
    blockTime: STEP_TIME[step],
    instructionIndex: 0,
    eventIndex: n,
    payload,
  });
}

function screen(s: State, step: ScenarioStep, wallet: string, status: ScreeningAccount['status']): void {
  const record: ScreeningAccount = {
    wallet,
    status,
    sourceHash: mockHex32(`screening-source:${wallet}`),
    screenedAt: STEP_TIME[step],
    expiresAt: STEP_TIME[step] + 30 * 86_400,
    bump: 255,
  };
  s.screenings.set(wallet, record);
  emit(s, step, { program: 'registry', name: 'ScreeningRecorded', data: { wallet, status, sourceHash: record.sourceHash, expiresAt: record.expiresAt } });
}

function keeperAction(s: State, at: number, outcome: KeeperAction['outcome'], reason: KeeperAction['reason'], nextAttemptAt: number | null): void {
  const id = `keeper-${s.keeperActions.length + 1}`;
  s.keeperActions.push({
    id,
    job: MOCK_IDS.job,
    action: 'finalizePayment',
    outcome,
    reason,
    signature: outcome === 'confirmed' ? mockSignature(`keeper:${id}`) : null,
    keeperFee: outcome === 'confirmed' ? KEEPER_FEE.toString() : null,
    at,
    nextAttemptAt,
  });
}

/** Adımı durum üzerinde uygular. Varyantın durduğu adım `VARIANTS[v].lastStep`'tir. */
const APPLY: Record<ScenarioStep, (s: State, v: ScenarioVariant) => void> = {
  1(s) {
    s.institution = {
      ownerKey: ROLES.institution.wallet,
      policyCount: 1,
      createdAt: STEP_TIME[1],
      bump: 255,
      name: 'Acme Treasury',
      multisig: null,
      multisigVault: null,
    };
    s.policy = {
      institution: MOCK_IDS.institution,
      policyId: mockHex32('policy-id'),
      commitment: mockHex32('policy-commitment'),
      dailyCeiling: DAILY_CEILING.toString(),
      buyerRoot: ZERO_HEX32,
      version: 1,
      active: true,
      createdAt: STEP_TIME[1],
      updatedAt: STEP_TIME[1],
      bump: 254,
    };
    s.policyMeta = {
      name: 'Araştırma harcama yetkisi',
      description: 'Agent işleri için işlem başı ve günlük tavanlı harcama yetkisi. Kuralların kendisi zincire ve API\'ye çıkmaz.',
      labels: ['research', 'usdc'],
      updatedAt: STEP_TIME[1],
    };
    emit(s, 1, { program: 'policy', name: 'InstitutionCreated', data: { institution: MOCK_IDS.institution, ownerKey: ROLES.institution.wallet, name: 'Acme Treasury' } });
    emit(s, 1, {
      program: 'policy',
      name: 'PolicyCommitted',
      data: {
        policy: MOCK_IDS.policy,
        institution: MOCK_IDS.institution,
        policyId: s.policy.policyId,
        commitment: s.policy.commitment,
        dailyCeiling: s.policy.dailyCeiling,
        version: 1,
      },
    });
  },

  2(s) {
    s.agent = {
      creator: MOCK_IDS.agentOwner,
      owner: MOCK_IDS.agentOwner,
      wallet: MOCK_IDS.agentWallet,
      agentCardHash: mockHex32('agent-card-hash'),
      status: 'active',
      registeredAt: STEP_TIME[2],
      updatedAt: STEP_TIME[2],
      bump: 255,
      agentId: 'scribe',
      agentCardUri: AGENT_CARD_URI,
    };
    emit(s, 2, {
      program: 'registry',
      name: 'AgentRegistered',
      data: {
        agentRecord: MOCK_IDS.agentRecord,
        creator: MOCK_IDS.agentOwner,
        owner: MOCK_IDS.agentOwner,
        agentId: 'scribe',
        wallet: MOCK_IDS.agentWallet,
        agentCardHash: s.agent.agentCardHash,
      },
    });
  },

  3(s, v) {
    screen(s, 3, ROLES.institution.wallet, 'clear');
    screen(s, 3, MOCK_IDS.agentWallet, v === 'screeningFlagged' ? 'flagged' : 'clear');
    s.job = {
      institution: ROLES.institution.wallet,
      agentRecord: MOCK_IDS.agentRecord,
      agentWallet: MOCK_IDS.agentWallet,
      mint: USDC_DEVNET,
      rentPayer: ROLES.institution.wallet,
      amount: AMOUNT.toString(),
      specHash: mockHex32('job-spec'),
      status: 'open',
      createdAt: STEP_TIME[3],
      fundedAt: 0,
      deadline: STEP_TIME[3] + 7 * 86_400,
      challengePeriod: CHALLENGE_PERIOD.toString(),
      challengeEnd: 0,
      deliveredAt: 0,
      settledAt: 0,
      workHash: ZERO_HEX32,
      travelRuleCommitment: ZERO_HEX32,
      policyCommitment: mockHex32('policy-commitment'),
      policyDailyCeiling: DAILY_CEILING.toString(),
      policyVersion: 1,
      bump: 255,
      vaultBump: 254,
      bondBump: 253,
      policy: MOCK_IDS.policy,
      dispute: DEFAULT_DISPUTE,
      deliveryUri: '',
    };
    emit(s, 3, {
      program: 'escrow',
      name: 'JobCreated',
      data: {
        job: MOCK_IDS.job,
        institution: s.job.institution,
        agentRecord: MOCK_IDS.agentRecord,
        agentWallet: MOCK_IDS.agentWallet,
        policy: MOCK_IDS.policy,
        policyVersion: 1,
        mint: USDC_DEVNET,
        amount: s.job.amount,
        specHash: s.job.specHash,
        deadline: s.job.deadline,
        challengePeriod: s.job.challengePeriod,
      },
    });
    if (v === 'screeningFlagged') return; // fund_job → ScreeningFlagged (6017); iş open kalır
    s.job = { ...s.job, status: 'funded', fundedAt: STEP_TIME[3] + 30 };
    emit(s, 3, { program: 'escrow', name: 'JobFunded', data: { job: MOCK_IDS.job, amount: s.job.amount } });
  },

  4(s) {
    const job = s.job!;
    emit(s, 4, { program: 'escrow', name: 'JobAccepted', data: { job: MOCK_IDS.job, agentRecord: MOCK_IDS.agentRecord, agentWallet: MOCK_IDS.agentWallet } });
    const workHash = mockHex32('delivery');
    const deliveryUri = `https://mock.square.example/deliveries/${MOCK_IDS.job}/report.md`;
    s.job = { ...job, status: 'delivered', deliveredAt: STEP_TIME[4], challengeEnd: CHALLENGE_END, workHash, deliveryUri };
    emit(s, 4, { program: 'escrow', name: 'WorkSubmitted', data: { job: MOCK_IDS.job, workHash, deliveryUri, challengeEnd: CHALLENGE_END } });
    keeperAction(s, STEP_TIME[4] + 1_800, 'skipped', 'challengeOpen', CHALLENGE_END);
  },

  5(s) {
    const buyerRoot = mockHex32('buyer-root');
    s.policy = { ...s.policy!, buyerRoot, updatedAt: STEP_TIME[5] };
    emit(s, 5, { program: 'policy', name: 'BuyerRootCommitted', data: { policy: MOCK_IDS.policy, buyerRoot } });
    screen(s, 5, ROLES.buyer.wallet, 'clear');
    s.claim = {
      job: MOCK_IDS.job,
      seller: MOCK_IDS.agentWallet,
      buyer: ZERO_ADDRESS,
      rentPayer: MOCK_IDS.agentWallet,
      price: CLAIM_PRICE.toString(),
      faceValue: NET.toString(),
      listedAt: STEP_TIME[5],
      boughtAt: 0,
      status: 'listed',
      bump: 255,
    };
    emit(s, 5, { program: 'escrow', name: 'ClaimListed', data: { job: MOCK_IDS.job, seller: MOCK_IDS.agentWallet, price: s.claim.price, faceValue: s.claim.faceValue } });
    s.claim = { ...s.claim, buyer: ROLES.buyer.wallet, boughtAt: STEP_TIME[5] + 300, status: 'bought' };
    emit(s, 5, { program: 'escrow', name: 'ClaimBought', data: { job: MOCK_IDS.job, buyer: ROLES.buyer.wallet, price: s.claim.price } });
  },

  6(s) {
    // Policy'li işte ispat bağlanmadan finalize: ProofRequired (6039); escrow bekler.
    keeperAction(s, STEP_TIME[6], 'skipped', 'proofRequired', STEP_TIME[6] + 300);
  },

  7(s, v) {
    const refused = v === 'releaseRefused';
    s.releaseProof = {
      job: MOCK_IDS.job,
      institution: MOCK_IDS.institution,
      policy: MOCK_IDS.policy,
      payee: ROLES.buyer.wallet,
      netAmount: NET.toString(),
      mint: USDC_DEVNET,
      dailySpentBefore: '0',
      proofTimestamp: STEP_TIME[7] - 30,
      verdict: refused ? 'refused' : 'compliant',
      refusalCode: refused ? REFUSAL_CODE : 0,
      consumed: false,
      bump: 255,
    };
    emit(s, 7, {
      program: 'verifier',
      name: 'ComplianceProofSet',
      data: {
        job: MOCK_IDS.job,
        policy: MOCK_IDS.policy,
        verdict: s.releaseProof.verdict,
        refusalCode: s.releaseProof.refusalCode,
        payee: ROLES.buyer.wallet,
        netAmount: NET.toString(),
        mint: USDC_DEVNET,
        dailySpentBefore: '0',
      },
    });
  },

  8(s, v) {
    const refused = v === 'releaseRefused';
    s.releaseProof = { ...s.releaseProof!, consumed: true };
    s.job = { ...s.job!, status: refused ? 'refunded' : 'released', settledAt: STEP_TIME[8] };
    s.claim = { ...s.claim!, status: refused ? 'defaulted' : 'settled' };
    if (refused) {
      emit(s, 8, {
        program: 'escrow',
        name: 'ReleaseRefused',
        data: { job: MOCK_IDS.job, refusalCode: REFUSAL_CODE, refundedAmount: NET.toString(), releaseProof: MOCK_IDS.releaseProof },
      });
    } else {
      emit(s, 8, {
        program: 'escrow',
        name: 'ReleaseVerified',
        data: { job: MOCK_IDS.job, payee: ROLES.buyer.wallet, netAmount: NET.toString(), releaseProof: MOCK_IDS.releaseProof },
      });
      emit(s, 8, {
        program: 'verifier',
        name: 'ReleaseRecorded',
        data: {
          job: MOCK_IDS.job,
          institution: MOCK_IDS.institution,
          netAmount: NET.toString(),
          dailySpent: NET.toString(),
          dayStartUnix: STEP_TIME[8] - (STEP_TIME[8] % 86_400),
        },
      });
    }
    emit(s, 8, { program: 'escrow', name: 'Finalized', data: { job: MOCK_IDS.job, keeper: ROLES.keeper.wallet, keeperFee: KEEPER_FEE.toString() } });
    s.reputation = {
      agentRecord: MOCK_IDS.agentRecord,
      jobsCompleted: refused ? '0' : '1',
      jobsFailed: refused ? '1' : '0',
      jobsDisputed: '0',
      totalEarned: refused ? '0' : NET.toString(),
      firstJobAt: STEP_TIME[8],
      lastJobAt: STEP_TIME[8],
      bump: 255,
    };
    emit(s, 8, {
      program: 'escrow',
      name: 'ReputationRecorded',
      data: {
        agentRecord: MOCK_IDS.agentRecord,
        job: MOCK_IDS.job,
        jobsCompleted: s.reputation.jobsCompleted,
        jobsFailed: s.reputation.jobsFailed,
        jobsDisputed: '0',
        totalEarned: s.reputation.totalEarned,
      },
    });
    s.validation = {
      job: MOCK_IDS.job,
      agentRecord: MOCK_IDS.agentRecord,
      outcome: refused ? 'refused' : 'verified',
      refusalCode: refused ? REFUSAL_CODE : 0,
      recordedAt: STEP_TIME[8],
      bump: 255,
      policy: MOCK_IDS.policy,
      releaseProof: MOCK_IDS.releaseProof,
    };
    emit(s, 8, {
      program: 'escrow',
      name: 'ValidationRecorded',
      data: { job: MOCK_IDS.job, agentRecord: MOCK_IDS.agentRecord, outcome: s.validation.outcome, refusalCode: s.validation.refusalCode },
    });
    keeperAction(s, STEP_TIME[8], 'confirmed', null, null);
  },
};

/** (varyant, adım) için tam görünüm. Saf ve deterministiktir; aynı girdi her zaman aynı çıktıyı verir. */
export function buildWorld(variant: ScenarioVariant, step: ScenarioStep): MockWorld {
  const s: State = {
    institution: null,
    policy: null,
    policyMeta: null,
    agent: null,
    reputation: null,
    screenings: new Map(),
    job: null,
    claim: null,
    releaseProof: null,
    validation: null,
    events: [],
    keeperActions: [],
  };
  const reachedStep = Math.min(step, VARIANTS[variant].lastStep) as ScenarioStep;
  for (const n of SCENARIO_STEPS) {
    if (n > reachedStep) break;
    APPLY[n](s, variant);
  }
  // Bekletme: kurum ispatı bağlamadıkça keeper her turda yeniden dener.
  if (variant === 'proofPending') {
    for (const n of SCENARIO_STEPS) {
      if (n > reachedStep && n <= step) keeperAction(s, STEP_TIME[n], 'skipped', 'proofRequired', STEP_TIME[n] + 300);
    }
  }

  const now = STEP_TIME[step] + 30;
  const slot = slotAt(step) + 5;
  const fresh = { slot, indexedAt: now };
  const payee = s.claim && s.claim.status !== 'listed' ? s.claim.buyer : MOCK_IDS.agentWallet;

  return {
    variant,
    step,
    reachedStep,
    now,
    slot,
    institutions: s.institution ? [{ address: MOCK_IDS.institution, account: s.institution, ...fresh }] : [],
    policies: s.policy ? [{ address: MOCK_IDS.policy, account: s.policy, meta: s.policyMeta, ...fresh }] : [],
    agents: s.agent
      ? [{ address: MOCK_IDS.agentRecord, account: s.agent, did: DID, card: AGENT_CARD, cardVerified: true, reputation: s.reputation, ...fresh }]
      : [],
    screenings: [...s.screenings.values()].map((account) => ({
      address: mockAddress(`pda:screening:${account.wallet}`),
      account,
      fresh: account.status === 'clear' && account.expiresAt > now,
      ...fresh,
    })),
    jobs: s.job
      ? [{ address: MOCK_IDS.job, account: s.job, payee, claim: s.claim, releaseProof: s.releaseProof, validation: s.validation, ...fresh }]
      : [],
    claims: s.claim ? [{ address: MOCK_IDS.claim, job: MOCK_IDS.job, account: s.claim, ...fresh }] : [],
    disputes: [],
    events: s.events,
    keeperActions: s.keeperActions,
  };
}
