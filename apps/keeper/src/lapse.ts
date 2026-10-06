// Lapse crank'i (BE-22, ADR 0016 madde 3–4): son tarihi geçmiş açık dispute'ların permissionless
// `lapse_dispute`'u. Karar çıkmazsa ne bond ne escrow kilitli kalır: bond kuruma döner, iş `Delivered`'a geçer ve
// finalize crank'inin yolundan çözülür. Keeper ücreti yoktur; işlem ücretini (ve kurumun token hesabı yoksa onun
// rent'ini) keeper öder. Bir aday için:
// 1. Job zincirden okunur. Artık `Disputed` değilse (karar, lapse ya da ayna geride) atlanır, günlüğe yazılmaz.
//    Zincirdeki son tarih gelmediyse (yeni açılmış bir dispute) son tarihe kadar bekletilir (`challengeOpen`).
// 2. Tx SDK'nın `flow.lapseDispute`'uyla kurulur (bond varsa bond vault'u, kurumun token hesabı idempotent
//    açılır); priority fee job'un son ücretlerinin yüzdeliğidir.
// 3. İmzalı tx simüle edilir: `DisputeNotExpired` (zincir saati geride) bekletilir, `NoActiveDispute` atlanır,
//    diğer hatalar `failed` / `programError`.
// 4. Gönderilir (`submitted`), onaylanınca `confirmed`. Onaylanan kayıt da `nextAttemptAt` taşır: ayna
//    güncellenene kadar aynı işe yeniden gönderilmez.
import type { KeeperReason } from '@squaresdk/solana-db';
import type { Logger } from '@squaresdk/solana-observability';
import type { SquareClient } from '@squaresdk/solana-sdk';
import { PublicKey, type Connection, type Keypair } from '@solana/web3.js';
import { nextAttemptAt } from './decide.js';
import type { Journal } from './journal.js';
import type { KeeperMetrics } from './metrics.js';
import { confirmSignature, recentPriorityFee } from './send.js';

export interface LapseRound {
  readonly evaluated: number;
  readonly confirmed: number;
}

export interface LapseCrank {
  runOnce(): Promise<LapseRound>;
  /** Son başarılı turun zamanı (ms); hiç olmadıysa null. */
  lastSuccessAt(): number | null;
}

export interface LapseCrankDeps {
  readonly client: SquareClient;
  readonly connection: Connection;
  readonly journal: Journal;
  readonly keeper: Keypair;
  readonly fees: { readonly priorityFeePercentile: number; readonly maxComputeUnitPrice: bigint };
  readonly backoff: { readonly baseSeconds: number; readonly maxSeconds: number };
  readonly batchSize: number;
  readonly confirmPollMs: number;
  readonly metrics: KeeperMetrics;
  readonly log: Logger;
  /** Tur hatası ve başarısız lapse (`keeper_errors` alarmı). */
  readonly onError: () => void;
  readonly clock?: () => number;
}

type Outcome =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'skip'; readonly reason: 'challengeOpen'; readonly until?: Date }
  | { readonly kind: 'failed'; readonly reason: 'rpcError' | 'programError' };

/** Simülasyon hatası (Anchor'ın camelCase hata adı, SDK `mapError`). */
export function classifyLapseFailure(programError: string | null): Outcome {
  switch (programError) {
    case 'disputeNotExpired':
      return { kind: 'skip', reason: 'challengeOpen' };
    case 'noActiveDispute':
      return { kind: 'ignore' };
    default:
      return { kind: 'failed', reason: 'programError' };
  }
}

export function createLapseCrank(deps: LapseCrankDeps): LapseCrank {
  const { client, connection, journal, keeper, metrics, log } = deps;
  const clock = deps.clock ?? Date.now;
  let lastSuccess: number | null = null;

  async function record(job: string, outcome: Exclude<Outcome, { kind: 'ignore' }>, now: Date, detail: object) {
    const reason: KeeperReason = outcome.reason;
    const attempt = (await journal.consecutive(job, reason)) + 1;
    const next = outcome.kind === 'skip' && outcome.until ? outcome.until : nextAttemptAt(now, attempt, deps.backoff);
    const kind = outcome.kind === 'skip' ? 'skipped' : 'failed';
    await journal.write({ job, outcome: kind, reason, nextAttemptAt: next }, now);
    metrics.actions.inc({ action: 'lapseDispute', outcome: kind, reason });
    if (kind === 'failed') deps.onError();
    log.info(`lapse_${kind}`, { job, reason, attempt, nextAttemptAt: next.toISOString(), ...detail });
  }

  /** Bir aday: true ise onaylandı. */
  async function lapse(job: PublicKey, now: Date): Promise<boolean> {
    const address = job.toBase58();
    const account = await client.escrow.fetch('job', job);
    if (!account || !('disputed' in account.status)) return false;
    const deadline = account.dispute.deadline.toNumber();
    if (Math.floor(now.getTime() / 1000) < deadline) {
      await record(address, { kind: 'skip', reason: 'challengeOpen', until: new Date(deadline * 1000) }, now, {
        deadline,
      });
      return false;
    }
    const computeUnitPrice = await recentPriorityFee(connection, [job], deps.fees);
    const built = await client.flow.lapseDispute(
      { caller: keeper.publicKey, job },
      { feePayer: keeper.publicKey, computeUnitPrice },
    );
    built.transaction.sign([keeper]);
    const simulation = await connection.simulateTransaction(built.transaction, {
      sigVerify: false,
      commitment: 'confirmed',
    });
    if (simulation.value.err) {
      const outcome = classifyLapseFailure(client.mapError({ logs: simulation.value.logs ?? [] })?.name ?? null);
      if (outcome.kind !== 'ignore') await record(address, outcome, now, { err: simulation.value.err });
      return false;
    }
    const signature = await connection.sendRawTransaction(built.transaction.serialize(), { skipPreflight: true });
    const submittedAt = new Date(clock());
    // Onay kaydı gönderimden sonradır (günlük zamana göre sıralanır).
    const afterSubmit = () => new Date(Math.max(clock(), submittedAt.getTime() + 1));
    await journal.write({ job: address, outcome: 'submitted', reason: null, signature }, submittedAt);
    metrics.actions.inc({ action: 'lapseDispute', outcome: 'submitted', reason: 'none' });
    let err: unknown;
    try {
      err = await confirmSignature(connection, signature, built.lastValidBlockHeight, deps.confirmPollMs);
    } catch (error) {
      await record(address, { kind: 'failed', reason: 'rpcError' }, afterSubmit(), { signature, error });
      return false;
    }
    if (err) {
      await record(address, { kind: 'failed', reason: 'programError' }, afterSubmit(), { signature, err });
      return false;
    }
    const at = afterSubmit();
    await journal.write(
      {
        job: address,
        outcome: 'confirmed',
        reason: null,
        signature,
        nextAttemptAt: new Date(at.getTime() + deps.backoff.baseSeconds * 1000),
      },
      at,
    );
    metrics.actions.inc({ action: 'lapseDispute', outcome: 'confirmed', reason: 'none' });
    log.info('lapse_confirmed', { job: address, signature, bond: account.dispute.bond.toString() });
    return true;
  }

  return {
    async runOnce() {
      const now = new Date(clock());
      const candidates = await journal.candidates(now, deps.batchSize);
      let confirmed = 0;
      for (const candidate of candidates) {
        try {
          if (await lapse(new PublicKey(candidate.job), now)) confirmed += 1;
        } catch (error) {
          // RPC ya da gönderim hatası: dispute geri çekilmeyle yeniden denenir, tur sürer.
          log.warn('lapse_error', { job: candidate.job, error });
          await record(candidate.job, { kind: 'failed', reason: 'rpcError' }, now, {});
        }
      }
      lastSuccess = clock();
      if (candidates.length > 0) log.info('lapse_round', { evaluated: candidates.length, confirmed });
      return { evaluated: candidates.length, confirmed };
    },
    lastSuccessAt: () => lastSuccess,
  };
}
