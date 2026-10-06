// Rol panelleri (FE-11): kurumun işleri, politikaları ve günlük tavan kullanımı; agent'ın işleri, kazancı ve
// itibarı; alıcının alacakları. Listeler Square API'nin indexer'ından okunur (BE-14, BE-18): işler
// (`listJobs`), politikalar (`listPolicies`), agent'lar (`listAgents`), alacaklar (`listClaims`). Kurumun hesabı,
// günlük sayacı (`OperatorState`) ve zincir saati zincirden okunur: sayaç her release'te değişir, günü UTC'de
// döner (ADR 0012).
import type { PublicKey } from '@solana/web3.js';
import type { SquareApi } from '@squaresdk/solana-sdk';
import {
  dailySpentAt,
  dayStart,
  releaseNetAmount,
  SECONDS_PER_DAY,
  type OperatorCounter,
} from '@squaresdk/solana-policy';
import type {
  AgentView,
  ApiEnvelope,
  ClaimStatus,
  ClaimView,
  JobStatus,
  JobView,
  PolicyView,
} from '@squaresdk/solana-types';
import { sameNetwork } from './agent-directory';
import type { EscrowSetup } from './job-wizard';
import { unwrap } from './square-api';

/** API'nin sayfa üst sınırı (`limit` 1–200). */
export const DASHBOARD_PAGE_LIMIT = 200;
/** Bir listede okunan en fazla kayıt; fazlası varsa panel söyler, toplamlar okunanlar üzerindendir. */
export const DASHBOARD_MAX_ITEMS = 1_000;

export interface Listing<T> {
  items: T[];
  /** Filtreye uyan bütün kayıtlar; `items.length`'ten büyükse liste `DASHBOARD_MAX_ITEMS`'ta kesilmiştir. */
  total: number;
}

/** API'nin sayfalarını `DASHBOARD_MAX_ITEMS`'a kadar okur. */
export async function readListing<T>(
  page: (window: { page: number; limit: number }) => Promise<ApiEnvelope<T[]>>,
): Promise<Listing<T>> {
  const items: T[] = [];
  for (let number = 1; ; number += 1) {
    const envelope = await page({ page: number, limit: DASHBOARD_PAGE_LIMIT });
    const batch = unwrap(envelope);
    items.push(...batch);
    const total = envelope.meta.total ?? items.length;
    if (batch.length < DASHBOARD_PAGE_LIMIT || items.length >= Math.min(total, DASHBOARD_MAX_ITEMS)) {
      return { items: items.slice(0, DASHBOARD_MAX_ITEMS), total };
    }
  }
}

/** İşler, indexer'ın sırasıyla: oluşturulma zamanı yeniden eskiye, eşitlikte adres. */
const newestFirst = (a: JobView, b: JobView) =>
  b.account.createdAt - a.account.createdAt || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

/** Kasada tutarı kilitli işler: fonlanmış ve henüz ödenmemiş ya da iade edilmemiş (program arayüzü §6). */
export const ESCROWED_STATUSES = [
  'funded',
  'accepted',
  'delivered',
  'disputed',
  'resolved',
] as const satisfies readonly JobStatus[];

/** Normal yolda release'i bekleyen işler; dispute'lu işin sonucu henüz belli değildir. */
const AWAITING_RELEASE: readonly JobStatus[] = ['funded', 'accepted', 'delivered'];

const isEscrowed = (status: JobStatus) => (ESCROWED_STATUSES as readonly JobStatus[]).includes(status);

export interface JobTotals {
  /** Duruma göre iş sayısı. */
  counts: Record<JobStatus, number>;
  /** Kasada kilitli tutar (`ESCROWED_STATUSES`). */
  escrowed: bigint;
  /** Ödenmiş işlerin tutarı, keeper ücreti dahil. */
  released: bigint;
  /** Settlement mint'inden başka mint'teki işler: sayılır, tutarları toplamlara girmez. */
  otherMint: number;
}

/** İşlerin durum sayıları ve settlement mint'indeki tutarları. */
export function jobTotals(jobs: readonly JobView[], mint: string): JobTotals {
  const counts = {
    open: 0,
    funded: 0,
    accepted: 0,
    delivered: 0,
    disputed: 0,
    resolved: 0,
    released: 0,
    refunded: 0,
    cancelled: 0,
  } satisfies Record<JobStatus, number>;
  let escrowed = 0n;
  let released = 0n;
  let otherMint = 0;
  for (const { account } of jobs) {
    counts[account.status] += 1;
    if (account.mint !== mint) {
      otherMint += 1;
      continue;
    }
    if (isEscrowed(account.status)) escrowed += BigInt(account.amount);
    if (account.status === 'released') released += BigInt(account.amount);
  }
  return { counts, escrowed, released, otherMint };
}

// ------------------------------------------------------------------ kurum

export interface InstitutionOverview {
  /** square_policy `Institution` PDA'sı (`["institution", owner]`). */
  institution: string;
  /** Kurum hesabı; henüz açılmadıysa (ilk politika commit edilmeden) null. */
  account: { name: string; policyCount: number; multisigVault: string | null } | null;
  /**
   * Kurumun günlük sayacı ve verifier'ın kaydettiği ödeme sayısı (`total_lifetime_payments`, her ödenen release'te
   * bir artar; tutar değildir). İlk release'ten önce hesap yoktur.
   */
  operator: (OperatorCounter & { totalLifetimePayments: bigint }) | null;
  policies: Listing<PolicyView>;
  /** Cüzdanın ve varsa Squads vault'unun açtığı işler (escrow'da `institution` imzacıdır). */
  jobs: Listing<JobView>;
}

const big = (value: { toString(): string }) => BigInt(value.toString());

/** Kurumun hesabı ve sayacı zincirden; politikaları ve işleri API'den. */
export async function readInstitutionOverview(
  api: SquareApi,
  setup: EscrowSetup,
  owner: PublicKey,
): Promise<InstitutionOverview> {
  const { client } = setup;
  const [institution] = client.pda.institution(owner);
  const [account, operator, policies] = await Promise.all([
    client.policy.fetch('institution', institution),
    client.verifier.fetch('operatorState', client.pda.operatorState(institution)[0]),
    readListing((window) => api.listPolicies({ institution: institution.toBase58(), ...window })),
  ]);
  const vault = account?.multisigVault?.toBase58() ?? null;
  const signers = [owner.toBase58(), ...(vault && vault !== owner.toBase58() ? [vault] : [])];
  const listings = await Promise.all(
    signers.map((signer) => readListing((window) => api.listJobs({ institution: signer, ...window }))),
  );
  return {
    institution: institution.toBase58(),
    account: account && {
      name: account.name,
      policyCount: account.policyCount,
      multisigVault: vault,
    },
    operator: operator && {
      dayStartUnix: operator.dayStartUnix.toNumber(),
      dailySpent: big(operator.dailySpent),
      totalLifetimePayments: big(operator.totalLifetimePayments),
    },
    policies,
    jobs: {
      items: listings.flatMap((listing) => listing.items).sort(newestFirst),
      total: listings.reduce((sum, listing) => sum + listing.total, 0),
    },
  };
}

export interface CeilingUse {
  policy: string;
  /** Politikanın herkese açık adı (API meta verisi); yoksa null. */
  name: string | null;
  version: number;
  ceiling: bigint;
  /** Bugün kalan; sayaç bilinmiyorsa null. */
  remaining: bigint | null;
}

export interface DailyUsage {
  /** Sayacın bugünkü (UTC günü) değeri; sayaç zincir saatinden ileri bir güne aitse null. */
  spent: bigint | null;
  /** Sayacın sıfırlanacağı an: bir sonraki UTC gününün başı. */
  resetsAt: number;
  /** Etkin politikaların tavanı: sayaç kurumundur, tavan her politikanın kendi `daily_ceiling`'idir. */
  ceilings: CeilingUse[];
}

/** Günlük tavan kullanımı, zincir saatine göre (`daily_spent_at`); ilk release'ten önce sayaç 0'dır. */
export function dailyUsage(
  operator: OperatorCounter | null,
  chainNow: number,
  policies: readonly PolicyView[],
): DailyUsage {
  const spent = operator ? dailySpentAt(operator.dayStartUnix, operator.dailySpent, chainNow) : 0n;
  const ceilings = policies
    .filter((policy) => policy.account.active)
    .map((policy) => {
      const ceiling = BigInt(policy.account.dailyCeiling);
      return {
        policy: policy.address,
        name: policy.meta?.name ?? null,
        version: policy.account.version,
        ceiling,
        remaining: spent === null ? null : ceiling > spent ? ceiling - spent : 0n,
      };
    });
  return { spent, resetsAt: dayStart(chainNow) + SECONDS_PER_DAY, ceilings };
}

/** `part / whole` yüzde olarak, en fazla iki ondalıkla ve aşağı yuvarlanarak: 1 / 8 → "12.5%". */
export function percentOf(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0%';
  const hundredths = (part * 10_000n) / whole;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${hundredths / 100n}${fraction ? `.${fraction}` : ''}%`;
}

// ------------------------------------------------------------------ agent

export interface AgentOverview {
  agents: { view: AgentView; jobs: Listing<JobView> }[];
  /** Cüzdanın bütün agent kayıtları (API). */
  total: number;
  /** Başka ağın ya da registry'nin agent'ları: API başka bir indexer'ı okuyor olabilir, gösterilmez. */
  otherNetwork: number;
}

/** Cüzdanın sahibi olduğu agent kayıtları ve her birinin işleri. */
export async function readAgentOverview(
  api: SquareApi,
  owner: string,
  expected: { chainRef: string; registry: string | null },
): Promise<AgentOverview> {
  const listing = await readListing((window) => api.listAgents({ owner, ...window }));
  const mine = listing.items.filter((agent) => sameNetwork(agent, expected));
  const agents = await Promise.all(
    mine.map(async (view) => ({
      view,
      jobs: await readListing((window) => api.listJobs({ agentRecord: view.address, ...window })),
    })),
  );
  return { agents, total: listing.total, otherNetwork: listing.items.length - mine.length };
}

/** Alacağı satılmış iş: alıcı fiyatı ödemiştir, release'in neti ona gider (ADR 0014). */
const soldClaim = (job: JobView) => job.claim !== null && job.claim.status !== 'listed';

export interface AgentEarnings {
  /**
   * `AgentReputation.total_earned`: release'te agent tarafına giden netlerin toplamı. İtibar kayda bağlıdır;
   * alacağı satılmış işlerin neti de buradadır, o tutarı alıcı aldı (ADR 0013).
   */
  released: bigint;
  /** Satılan alacaklar: fiyat satışta agent cüzdanına geçti. */
  sold: { count: number; price: bigint };
  /** Release'i bekleyen, alacağı satılmamış işler: bugünkü keeper ücretiyle agent cüzdanına gidecek net. */
  pending: { count: number; net: bigint };
}

export function agentEarnings(
  view: AgentView,
  jobs: readonly JobView[],
  keeperFeeBps: number,
  mint: string,
): AgentEarnings {
  const earnings: AgentEarnings = {
    released: view.reputation ? BigInt(view.reputation.totalEarned) : 0n,
    sold: { count: 0, price: 0n },
    pending: { count: 0, net: 0n },
  };
  for (const job of jobs) {
    if (job.account.mint !== mint) continue;
    if (soldClaim(job)) {
      earnings.sold.count += 1;
      earnings.sold.price += BigInt(job.claim!.price);
    } else if (AWAITING_RELEASE.includes(job.account.status)) {
      earnings.pending.count += 1;
      earnings.pending.net += releaseNetAmount(BigInt(job.account.amount), keeperFeeBps);
    }
  }
  return earnings;
}

// ------------------------------------------------------------------ alıcı

/** Cüzdanın aldığı alacaklar. */
export const readBuyerClaims = (api: SquareApi, buyer: string): Promise<Listing<ClaimView>> =>
  readListing((window) => api.listClaims({ buyer, ...window }));

export interface ClaimTotals {
  count: number;
  /** Alıcının ödediği fiyatlar. */
  price: bigint;
  /** Yüz değer: işin escrow'daki tutarı (`face_value = job.amount`). */
  faceValue: bigint;
}

export type HeldStatus = Exclude<ClaimStatus, 'listed'>;

export interface BuyerTotals extends Record<HeldStatus, ClaimTotals> {
  /** Kapanmasını bekleyen (`bought`) alacakların release'teki neti, bugünkü keeper ücretiyle. */
  expectedPayout: bigint;
}

/**
 * Alacakların durumuna göre toplamı: `bought` işin kapanmasını bekler, `settled`'da release'in neti alıcıya
 * gitti, `defaulted`'da iş kuruma iade edildi ve alıcıya ödeme yapılmadı.
 */
export function buyerTotals(claims: readonly ClaimView[], keeperFeeBps: number): BuyerTotals {
  const totals: BuyerTotals = {
    bought: { count: 0, price: 0n, faceValue: 0n },
    settled: { count: 0, price: 0n, faceValue: 0n },
    defaulted: { count: 0, price: 0n, faceValue: 0n },
    expectedPayout: 0n,
  };
  for (const { account } of claims) {
    if (account.status === 'listed') continue;
    const entry = totals[account.status];
    const faceValue = BigInt(account.faceValue);
    entry.count += 1;
    entry.price += BigInt(account.price);
    entry.faceValue += faceValue;
    if (account.status === 'bought') totals.expectedPayout += releaseNetAmount(faceValue, keeperFeeBps);
  }
  return totals;
}
