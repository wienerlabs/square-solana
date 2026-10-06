// Agent dizini ve profili (FE-05, akışın 2. adımı; BE-14 indexer, BE-18 API): kayıtlı agent'lar, Square
// API'de barındırılan kartları (beceriler, fiyatlar), itibarları (`AgentReputation`) ve işleri (validation
// kayıtlarıyla). Beceri ve durum filtresi API'dedir (`listAgents`: beceri kimliği ya da etiketi); fiyat ve
// itibar filtresi okunan agent'lar üzerinde uygulanır. Kartı Square API'de barındırılmayan agent'ın kartı
// API'de yoktur: o kartı DID çözümü kendi adresinden okur.
import { squareIdentity } from '@squaresdk/solana-identity';
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { AgentCard, AgentView, JobView, ValidationRecord } from '@squaresdk/solana-types';
import { unwrap } from './square-api';

/** API'nin sayfa üst sınırı (`limit` 1–200). */
export const DIRECTORY_PAGE_LIMIT = 200;
/** Dizinde okunan en fazla agent; fiyat ve itibar filtresi bunlar üzerinde uygulanır. */
export const DIRECTORY_MAX_AGENTS = 1_000;
/** Profilde okunan en fazla iş, yeniden eskiye. */
export const PROFILE_JOBS_LIMIT = 50;

export interface Directory {
  agents: AgentView[];
  /** Filtreye uyan bütün agent'lar; `agents.length`'ten büyükse dizin `DIRECTORY_MAX_AGENTS`'ta kesilmiştir. */
  total: number;
}

/** Dizin: API'nin sayfaları `DIRECTORY_MAX_AGENTS`'a kadar okunur. Varsayılan olarak yalnızca etkin agent'lar. */
export async function readDirectory(
  api: SquareApi,
  query: { skill: string | null; includeInactive: boolean },
): Promise<Directory> {
  const agents: AgentView[] = [];
  for (let page = 1; ; page += 1) {
    const envelope = await api.listAgents({
      page,
      limit: DIRECTORY_PAGE_LIMIT,
      ...(query.skill !== null && { skill: query.skill }),
      ...(!query.includeInactive && { status: 'active' as const }),
    });
    const items = unwrap(envelope);
    agents.push(...items);
    const total = envelope.meta.total ?? agents.length;
    if (items.length < DIRECTORY_PAGE_LIMIT || agents.length >= Math.min(total, DIRECTORY_MAX_AGENTS)) {
      return { agents: agents.slice(0, DIRECTORY_MAX_AGENTS), total };
    }
  }
}

/**
 * Agent bu ağın ve bu registry'nin mi? API başka bir kümenin ya da eski bir registry'nin indexer'ını
 * okuyor olabilir; DID'deki zincir referansı ve registry kimliği karşılaştırılır. Registry yapılandırılmamışsa
 * yalnızca zincir.
 */
export function sameNetwork(agent: AgentView, expected: { chainRef: string; registry: string | null }): boolean {
  try {
    const parsed = squareIdentity.parseDidAip(agent.did);
    return (
      parsed.version === 2 &&
      parsed.namespace === 'solana' &&
      parsed.chainRef === expected.chainRef &&
      (expected.registry === null || parsed.registry === expected.registry)
    );
  } catch {
    return false;
  }
}

/** Kartın, beceri kimliği ya da etiketi `skill` olan becerileri. */
export const matchingSkills = (card: AgentCard, skill: string) =>
  card.skills.filter((entry) => entry.id === skill || entry.tags.includes(skill));

/**
 * Kartın settlement mint'indeki en düşük fiyatı (taban birim): beceri verilirse yalnızca ona uyan becerilerin
 * fiyatları. Başka mint'teki fiyat karşılaştırılmaz; fiyatı olmayan kartta null.
 */
export function priceOf(card: AgentCard | null, skill: string | null, mint: string): bigint | null {
  if (!card?.pricing) return null;
  const skills = skill === null ? null : new Set(matchingSkills(card, skill).map((entry) => entry.id));
  let lowest: bigint | null = null;
  for (const entry of card.pricing) {
    if (entry.mint !== mint || (skills !== null && !skills.has(entry.skillId))) continue;
    const amount = BigInt(entry.amount);
    if (lowest === null || amount < lowest) lowest = amount;
  }
  return lowest;
}

export type DirectorySort = 'completed' | 'price' | 'newest';

export const SORT_LABEL: Readonly<Record<DirectorySort, string>> = {
  completed: 'Most completed jobs',
  price: 'Lowest price',
  newest: 'Newest',
};

export interface DirectoryRow {
  agent: AgentView;
  /** Settlement mint'indeki fiyat; mint bilinmiyorsa ya da kartta fiyat yoksa null. */
  price: bigint | null;
  completed: bigint;
  earned: bigint;
}

/** Okunan agent'lar fiyat ve itibar filtresinden geçer, sıralanır. Fiyat sınırı varken fiyatı olmayan agent görünmez. */
export function directoryRows(
  agents: readonly AgentView[],
  params: {
    skill: string | null;
    maxPrice: bigint | null;
    minCompleted: bigint | null;
    sort: DirectorySort;
    /** Settlement mint'i; bilinmiyorsa fiyatlar karşılaştırılmaz. */
    mint: string | null;
  },
): DirectoryRow[] {
  const rows = agents
    .map((agent) => ({
      agent,
      price: params.mint === null ? null : priceOf(agent.card, params.skill, params.mint),
      completed: BigInt(agent.reputation?.jobsCompleted ?? '0'),
      earned: BigInt(agent.reputation?.totalEarned ?? '0'),
    }))
    .filter((row) => params.maxPrice === null || (row.price !== null && row.price <= params.maxPrice))
    .filter((row) => params.minCompleted === null || row.completed >= params.minCompleted);
  const byAddress = (a: DirectoryRow, b: DirectoryRow) => a.agent.address.localeCompare(b.agent.address);
  const compare: Record<DirectorySort, (a: DirectoryRow, b: DirectoryRow) => number> = {
    completed: (a, b) =>
      a.completed !== b.completed
        ? Number(b.completed - a.completed)
        : a.earned !== b.earned
          ? Number(b.earned - a.earned)
          : byAddress(a, b),
    price: (a, b) =>
      a.price === b.price ? byAddress(a, b) : a.price === null ? 1 : b.price === null ? -1 : Number(a.price - b.price),
    newest: (a, b) => b.agent.account.registeredAt - a.agent.account.registeredAt || byAddress(a, b),
  };
  return rows.sort(compare[params.sort]);
}

export type ParsedCount = { ok: true; value: bigint } | { ok: false; error: string };

/** "En az tamamlanmış iş" girdisi: negatif olmayan tam sayı. */
export function parseCount(text: string): ParsedCount {
  return /^(0|[1-9][0-9]{0,18})$/.test(text)
    ? { ok: true, value: BigInt(text) }
    : { ok: false, error: 'Use a whole number of jobs.' };
}

export interface AgentProfile {
  agent: AgentView;
  /** Agent'ın işleri, yeniden eskiye; en fazla `PROFILE_JOBS_LIMIT`. */
  jobs: JobView[];
  totalJobs: number;
}

/** Profil: agent ve işleri. API agent'ı indexlemediyse null. */
export async function readAgentProfile(api: SquareApi, agentRecord: string): Promise<AgentProfile | null> {
  const found = await api.getAgent(agentRecord);
  if (!found.success && found.error.code === 'not_found') return null;
  const agent = unwrap(found);
  const envelope = await api.listJobs({ agentRecord, limit: PROFILE_JOBS_LIMIT });
  const jobs = unwrap(envelope);
  return { agent, jobs, totalJobs: envelope.meta.total ?? jobs.length };
}

/** Settlement'ı yazılmış işlerin validation kayıtları, yeniden eskiye. */
export function validationHistory(jobs: readonly JobView[]): { job: string; record: ValidationRecord }[] {
  return jobs
    .flatMap((job) => (job.validation ? [{ job: job.address, record: job.validation }] : []))
    .sort((a, b) => b.record.recordedAt - a.record.recordedAt || a.job.localeCompare(b.job));
}
