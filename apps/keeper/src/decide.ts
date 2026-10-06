// Finalize kararı (saf fonksiyonlar; zincir okuması ve gönderim crank.ts'te). Kurallar `finalize_payment`'ın
// ve ADR 0013'ün kurallarıdır:
// - Job `Delivered` ve challenge penceresi bitmiş olmalı (`now >= challenge_end`).
// - Keeper ücreti `amount × keeper_fee_bps / 10 000` (aşağı), net `amount − ücret`; payee alacak satıldıysa
//   alıcı, değilse agent cüzdanı.
// - Policy'li işte bağlı, tüketilmemiş bir `ReleaseProof` gerekir; yoksa escrow bekler (`ProofRequired`).
//   İspat payee / net / mint'te release'in hâline uymuyorsa bayattır (`StaleReleaseProof`).
// - Ödeme dalında payee'nin screening kaydı temiz ve taze olmalı (`expires_at > now`); değilse bekler.
// Ret içeren ispatın kalıcı mı geçici mi olduğu ve günlük sayaç tazeliği burada yeniden yazılmaz: kesin
// karar simülasyonundur (`classifyFailure`).

/** `keeper_actions.reason` (API `KeeperReason`). */
export type SkipReason = 'challengeOpen' | 'proofRequired' | 'staleProof' | 'screeningPending' | 'unprofitable';
export type FailureReason = 'rpcError' | 'programError';

export interface JobFacts {
  readonly status: string;
  readonly challengeEnd: number;
  readonly amount: bigint;
  readonly mint: string;
  readonly policy: string | null;
  readonly agentWallet: string;
}

export interface ProofFacts {
  readonly consumed: boolean;
  readonly verdict: 'compliant' | 'refused';
  readonly payee: string;
  readonly netAmount: bigint;
  readonly mint: string;
}

export interface ScreeningFacts {
  readonly status: 'clear' | 'flagged';
  readonly expiresAt: number;
}

export interface FinalizeFacts {
  /** Unix saniyesi. */
  readonly now: number;
  readonly keeperFeeBps: number;
  readonly job: JobFacts;
  /** `["claim", job]` listelemesi; yoksa null. */
  readonly listing: { readonly status: string; readonly buyer: string } | null;
  /** Policy'li işin `["release_proof", job]` hesabı; yoksa null. */
  readonly proof: ProofFacts | null;
  /** Payee'nin screening kaydı; yoksa null. */
  readonly payeeScreening: ScreeningFacts | null;
}

export type Precheck =
  /** Job artık finalize edilecek durumda değil (zaten kapanmış ya da başka duruma geçmiş): günlüğe yazılmaz. */
  | { readonly kind: 'ignore'; readonly status: string }
  | { readonly kind: 'skip'; readonly reason: SkipReason }
  | { readonly kind: 'proceed'; readonly payee: string; readonly fee: bigint; readonly net: bigint };

const BPS = 10_000n;

export const keeperFee = (amount: bigint, keeperFeeBps: number): bigint => (amount * BigInt(keeperFeeBps)) / BPS;

export const payeeOf = (facts: FinalizeFacts): string =>
  facts.listing?.status === 'bought' ? facts.listing.buyer : facts.job.agentWallet;

export function precheck(facts: FinalizeFacts): Precheck {
  const { job, now } = facts;
  if (job.status !== 'delivered') return { kind: 'ignore', status: job.status };
  if (now < job.challengeEnd) return { kind: 'skip', reason: 'challengeOpen' };
  const fee = keeperFee(job.amount, facts.keeperFeeBps);
  const net = job.amount - fee;
  const payee = payeeOf(facts);
  let paysAgentSide = true;
  if (job.policy !== null) {
    const proof = facts.proof;
    if (!proof || proof.consumed) return { kind: 'skip', reason: 'proofRequired' };
    if (proof.payee !== payee || proof.netAmount !== net || proof.mint !== job.mint) {
      return { kind: 'skip', reason: 'staleProof' };
    }
    // Ret kesinse iade dalıdır (screening aranmaz), geçiciyse bekler: ayrımı simülasyon yapar.
    paysAgentSide = proof.verdict === 'compliant';
  }
  if (paysAgentSide) {
    const screening = facts.payeeScreening;
    if (!screening || screening.status !== 'clear' || screening.expiresAt <= now) {
      return { kind: 'skip', reason: 'screeningPending' };
    }
  }
  return { kind: 'proceed', payee, fee, net };
}

export interface Economics {
  /** 1 SOL'ün settlement mint'inin taban birimindeki karşılığı. */
  readonly mintUnitsPerSol: bigint;
  /** Ücretin maliyeti aşması gereken pay (baz puan). */
  readonly minMarginBps: number;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Lamport maliyetinin settlement mint'indeki karşılığı (yukarı yuvarlanır: keeper zarar yazmaz). */
export const costInMintUnits = (lamports: bigint, mintUnitsPerSol: bigint): bigint =>
  (lamports * mintUnitsPerSol + LAMPORTS_PER_SOL - 1n) / LAMPORTS_PER_SOL;

/** Ücret, maliyeti en az `minMarginBps` payla aşıyor mu. */
export function profitable(fee: bigint, costLamports: bigint, economics: Economics): boolean {
  const cost = costInMintUnits(costLamports, economics.mintUnitsPerSol);
  return fee * BPS >= cost * (BPS + BigInt(economics.minMarginBps));
}

export type Outcome =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'skip'; readonly reason: SkipReason }
  | { readonly kind: 'failed'; readonly reason: FailureReason };

/**
 * Simülasyon ya da gönderim hatası. `programError` Anchor'ın camelCase hata adıdır (SDK `mapError`); escrow'un
 * bekleme hataları günlükte bekletme sebebi olur, `InvalidStatus` job'un artık finalize edilecek durumda
 * olmadığını gösterir.
 */
export function classifyFailure(programError: string | null): Outcome {
  switch (programError) {
    case 'proofRequired':
      return { kind: 'skip', reason: 'proofRequired' };
    case 'staleReleaseProof':
      return { kind: 'skip', reason: 'staleProof' };
    case 'screeningRequired':
    case 'screeningFlagged':
    case 'screeningExpired':
      return { kind: 'skip', reason: 'screeningPending' };
    case 'challengePeriodNotExpired':
      return { kind: 'skip', reason: 'challengeOpen' };
    case 'invalidStatus':
      return { kind: 'ignore' };
    default:
      return { kind: 'failed', reason: 'programError' };
  }
}

/**
 * Bekletilen job'un bir sonraki denemesi: `attempt`. ardışık bekletmede `base × 2^(attempt−1)`, en çok `max`
 * saniye sonra.
 */
export function nextAttemptAt(now: Date, attempt: number, backoff: { baseSeconds: number; maxSeconds: number }): Date {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const seconds = Math.min(backoff.maxSeconds, backoff.baseSeconds * 2 ** exponent);
  return new Date(now.getTime() + seconds * 1000);
}
