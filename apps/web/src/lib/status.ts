// Zincir durumlarının arayüzdeki tonu. Değer kümeleri IDL'den üretilen şemalardan gelir
// (@squaresdk/solana-types, BC-44); `satisfies Record<…>` yeni bir değer eklendiğinde tonunun da
// seçilmesini derleme anında zorunlu kılar.
import {
  AgentStatusSchema,
  ClaimStatusSchema,
  JobStatusSchema,
  ReleaseVerdictSchema,
  ScreeningStatusSchema,
  type AgentStatus,
  type ClaimStatus,
  type JobStatus,
  type ReleaseVerdict,
  type ScreeningStatus,
} from '@squaresdk/solana-types';
import type { Tone } from '@/components/ui/status-badge';

export const JOB_STATUS_TONE = {
  open: 'info',
  funded: 'info',
  accepted: 'info',
  delivered: 'warning',
  disputed: 'danger',
  resolved: 'neutral',
  released: 'success',
  refunded: 'neutral',
  cancelled: 'neutral',
} as const satisfies Record<JobStatus, Tone>;

export const CLAIM_STATUS_TONE = {
  listed: 'info',
  bought: 'info',
  settled: 'success',
  defaulted: 'danger',
} as const satisfies Record<ClaimStatus, Tone>;

export const RELEASE_VERDICT_TONE = {
  compliant: 'success',
  refused: 'danger',
} as const satisfies Record<ReleaseVerdict, Tone>;

export const AGENT_STATUS_TONE = {
  active: 'success',
  inactive: 'warning',
  deregistered: 'neutral',
} as const satisfies Record<AgentStatus, Tone>;

export const SCREENING_STATUS_TONE = {
  clear: 'success',
  flagged: 'danger',
} as const satisfies Record<ScreeningStatus, Tone>;

/** `noGate` → "No gate", `released` → "Released". */
export function statusLabel(value: string): string {
  const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface StatusSet {
  name: string;
  account: string;
  items: readonly { value: string; tone: Tone }[];
}

const set = <V extends string>(
  name: string,
  account: string,
  values: readonly V[],
  tones: Record<V, Tone>,
): StatusSet => ({
  name,
  account,
  items: values.map((value) => ({ value, tone: tones[value] })),
});

/** Bileşen kataloğu için: her zincir durumunun bütün değerleri, IDL sırasıyla. */
export const STATUS_SETS: readonly StatusSet[] = [
  set('Job', 'square_escrow · Job.status', JobStatusSchema.options, JOB_STATUS_TONE),
  set('Receivable', 'square_escrow · ClaimListing.status', ClaimStatusSchema.options, CLAIM_STATUS_TONE),
  set('Release proof', 'square_verifier · ReleaseProof.verdict', ReleaseVerdictSchema.options, RELEASE_VERDICT_TONE),
  set('Agent', 'square_registry · AgentRecord.status', AgentStatusSchema.options, AGENT_STATUS_TONE),
  set('Screening', 'square_registry · ScreeningRecord.status', ScreeningStatusSchema.options, SCREENING_STATUS_TONE),
];
