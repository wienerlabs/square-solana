// Finalize crank'i: her tur adayları (journal.ts) sırayla işler. Bir aday için:
// 1. Zincirden okunur ve ön kontrolden geçer (decide.ts `precheck`); bekletme günlüğe geri çekilmeyle yazılır.
// 2. Priority fee, job'un yazılabilir hesaplarının son ücretlerinin yüzdeliğidir (üst sınırlı).
// 3. Tx SDK'nın `flow.finalizePayment`'ıyla kurulur (compute sınırı BC-28 profilinden). Maliyet: mesajın ücreti
//    (`getFeeForMessage`: imza + priority fee) ve keeper'ın açacağı hesapların rent'i. Ücret maliyeti
//    `KEEPER_MIN_MARGIN_BPS` payla aşmıyorsa kârsızdır, günlüğe yazılır.
// 4. İmzalı tx simüle edilir; escrow'un bekleme hataları bekletme sebebi olur (`classifyFailure`).
// 5. Gönderilir (`submitted`), onaylanınca `confirmed` ve keeper ücreti günlüğe yazılır.
// Tur başında birikim (finalize edilebilir durumda bekleyen job'lar) ölçülür; onaylanan finalize'ın challenge
// bitişinden bu yana geçen süresi histograma yazılır.
import type { KeeperReason } from '@squaresdk/solana-db';
import type { Logger } from '@squaresdk/solana-observability';
import type { SquareClient } from '@squaresdk/solana-sdk';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PublicKey, TransactionMessage, VersionedTransaction, type Connection, type Keypair } from '@solana/web3.js';
import { classifyFailure, nextAttemptAt, precheck, profitable, type Economics, type Outcome } from './decide.js';
import type { Journal } from './journal.js';
import type { KeeperMetrics } from './metrics.js';
import { keeperTokenAccount, type StateReader } from './state.js';

export interface RoundResult {
  readonly evaluated: number;
  readonly confirmed: number;
}

export interface Crank {
  runOnce(): Promise<RoundResult>;
  /** Son başarılı turun zamanı (ms); hiç olmadıysa null. */
  lastSuccessAt(): number | null;
  /** Son okunan keeper bakiyesi (lamport); hiç okunmadıysa null. */
  lastBalance(): bigint | null;
  /** Son turda finalize edilebilir en eski job'un bekleme süresi (saniye); hiç tur olmadıysa null. */
  oldestDueSeconds(): number | null;
}

export interface CrankDeps {
  readonly client: SquareClient;
  readonly connection: Connection;
  readonly reader: StateReader;
  readonly journal: Journal;
  readonly keeper: Keypair;
  readonly economics: Economics & { readonly priorityFeePercentile: number; readonly maxComputeUnitPrice: bigint };
  readonly backoff: { readonly baseSeconds: number; readonly maxSeconds: number };
  readonly batchSize: number;
  /** Onay yoklama aralığı. */
  readonly confirmPollMs: number;
  readonly metrics: KeeperMetrics;
  readonly log: Logger;
  /** Tur hatası ve başarısız finalize (`keeper_errors` alarmı). */
  readonly onError: () => void;
  readonly clock?: () => number;
}

/** Yüzdelik (en yakın sıra yöntemi); boş listede 0. */
export function percentile(values: readonly bigint[], p: number): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export function createCrank(deps: CrankDeps): Crank {
  const { client, connection, reader, journal, keeper, metrics, log } = deps;
  const clock = deps.clock ?? Date.now;
  const rentBySize = new Map<number, bigint>();
  const ensuredTokenAccounts = new Set<string>();
  let lastSuccess: number | null = null;
  let balance: bigint | null = null;
  let oldestDue: number | null = null;

  const rent = async (size: number) => {
    const cached = rentBySize.get(size);
    if (cached !== undefined) return cached;
    const lamports = BigInt(await connection.getMinimumBalanceForRentExemption(size));
    rentBySize.set(size, lamports);
    return lamports;
  };

  async function record(
    job: string,
    outcome: Exclude<Outcome, { kind: 'ignore' }>,
    now: Date,
    detail: Record<string, unknown>,
  ) {
    const reason: KeeperReason = outcome.reason;
    const attempt = (await journal.consecutive(job, reason)) + 1;
    const next = nextAttemptAt(now, attempt, deps.backoff);
    const kind = outcome.kind === 'skip' ? 'skipped' : 'failed';
    await journal.write({ job, outcome: kind, reason, nextAttemptAt: next }, now);
    metrics.actions.inc({ outcome: kind, reason });
    if (kind === 'failed') deps.onError();
    log.info(`finalize_${kind}`, { job, reason, attempt, nextAttemptAt: next.toISOString(), ...detail });
  }

  /** Keeper'ın ücreti aldığı token hesabı; yoksa bir kez açılır (keeper'ın kendi hesabı, job'a maliyet değil). */
  async function ensureTokenAccount(mint: PublicKey, tokenProgram: PublicKey): Promise<PublicKey> {
    const address = keeperTokenAccount(keeper.publicKey, mint, tokenProgram);
    if (ensuredTokenAccounts.has(address.toBase58())) return address;
    if (!(await connection.getAccountInfo(address, 'confirmed'))) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({
        payerKey: keeper.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          createAssociatedTokenAccountIdempotentInstruction(
            keeper.publicKey,
            address,
            keeper.publicKey,
            mint,
            tokenProgram,
          ),
        ],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      tx.sign([keeper]);
      const signature = await connection.sendRawTransaction(tx.serialize());
      const err = await confirm(signature, lastValidBlockHeight);
      if (err) throw new Error(`keeper token hesabı açılamadı: ${JSON.stringify(err)}`);
      log.info('keeper_token_account_created', { address: address.toBase58(), signature });
    }
    ensuredTokenAccounts.add(address.toBase58());
    return address;
  }

  /**
   * Gönderilen tx'in onayı: imza durumu yoklanır; blockhash'in son geçerli blok yüksekliği aşılırsa tx düşmüştür.
   * Dönen değer tx'in hatası (başarılıysa null).
   */
  async function confirm(signature: string, lastValidBlockHeight: number): Promise<unknown> {
    for (;;) {
      const [status] = (await connection.getSignatureStatuses([signature])).value;
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        return status.err;
      }
      if ((await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
        throw new Error(`tx onaylanmadan blockhash'in süresi doldu: ${signature}`);
      }
      await new Promise((resolve) => setTimeout(resolve, deps.confirmPollMs));
    }
  }

  async function priorityFee(writable: readonly PublicKey[]): Promise<bigint> {
    const recent = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: [...writable] });
    const fee = percentile(
      recent.map((entry) => BigInt(entry.prioritizationFee)),
      deps.economics.priorityFeePercentile,
    );
    return fee > deps.economics.maxComputeUnitPrice ? deps.economics.maxComputeUnitPrice : fee;
  }

  /** Bir aday: true ise onaylandı. */
  async function finalize(job: PublicKey, keeperFeeBps: number, now: Date): Promise<boolean> {
    const address = job.toBase58();
    const state = await reader.read(job, Math.floor(now.getTime() / 1000), keeperFeeBps);
    if (!state) return false;
    const check = precheck(state.facts);
    if (check.kind === 'ignore') return false;
    if (check.kind === 'skip') {
      await record(address, check, now, {});
      return false;
    }
    const tokenAccount = await ensureTokenAccount(state.mint, state.tokenProgram);
    const computeUnitPrice = await priorityFee(state.writable);
    const built = await client.flow.finalizePayment(
      { keeper: keeper.publicKey, job, keeperTokenAccount: tokenAccount },
      { feePayer: keeper.publicKey, computeUnitPrice },
    );
    const messageFee = (await connection.getFeeForMessage(built.transaction.message, 'confirmed')).value;
    if (messageFee === null) throw new Error('işlem ücreti alınamadı (blockhash geçersiz)');
    const rents = await Promise.all(state.newAccountSizes.map(rent));
    const cost = BigInt(messageFee) + rents.reduce((sum, value) => sum + value, 0n);
    if (!profitable(check.fee, cost, deps.economics)) {
      await record(address, { kind: 'skip', reason: 'unprofitable' }, now, {
        keeperFee: check.fee.toString(),
        costLamports: cost.toString(),
      });
      return false;
    }
    built.transaction.sign([keeper]);
    const simulation = await connection.simulateTransaction(built.transaction, {
      sigVerify: false,
      commitment: 'confirmed',
    });
    if (simulation.value.err) {
      const outcome = classifyFailure(client.mapError({ logs: simulation.value.logs ?? [] })?.name ?? null);
      if (outcome.kind !== 'ignore') await record(address, outcome, now, { err: simulation.value.err });
      return false;
    }
    const signature = await connection.sendRawTransaction(built.transaction.serialize(), { skipPreflight: true });
    const submittedAt = new Date(clock());
    // Onay kaydı gönderimden sonradır (günlük zamana göre sıralanır).
    const afterSubmit = () => new Date(Math.max(clock(), submittedAt.getTime() + 1));
    await journal.write({ job: address, outcome: 'submitted', reason: null, signature }, submittedAt);
    metrics.actions.inc({ outcome: 'submitted', reason: 'none' });
    let err: unknown;
    try {
      err = await confirm(signature, built.lastValidBlockHeight);
    } catch (error) {
      // Tx onaylanmadan düştü ya da durum okunamadı: geri çekilmeyle yeniden denenir.
      await record(address, { kind: 'failed', reason: 'rpcError' }, afterSubmit(), { signature, error });
      return false;
    }
    if (err) {
      await record(address, { kind: 'failed', reason: 'programError' }, afterSubmit(), { signature, err });
      return false;
    }
    await journal.write(
      { job: address, outcome: 'confirmed', reason: null, signature, keeperFee: check.fee },
      afterSubmit(),
    );
    metrics.actions.inc({ outcome: 'confirmed', reason: 'none' });
    metrics.feesEarned.inc(Number(check.fee));
    metrics.finalizeDelay.observe(
      { gate: state.facts.job.policy === null ? 'none' : 'proof' },
      Math.max(0, clock() / 1000 - state.facts.job.challengeEnd),
    );
    log.info('finalize_confirmed', { job: address, signature, keeperFee: check.fee.toString() });
    return true;
  }

  return {
    async runOnce() {
      const now = new Date(clock());
      balance = BigInt(await connection.getBalance(keeper.publicKey, 'confirmed'));
      metrics.balance.set(Number(balance));
      const keeperFeeBps = await reader.keeperFeeBps();
      const backlog = await journal.backlog(now);
      oldestDue =
        backlog.oldestReadyAt === null ? 0 : Math.max(0, (now.getTime() - backlog.oldestReadyAt.getTime()) / 1000);
      metrics.dueJobs.set(backlog.due);
      metrics.oldestDue.set(oldestDue);
      const candidates = await journal.candidates(now, deps.batchSize);
      let confirmed = 0;
      for (const candidate of candidates) {
        try {
          if (await finalize(new PublicKey(candidate.job), keeperFeeBps, now)) confirmed += 1;
        } catch (error) {
          // RPC ya da gönderim hatası: job geri çekilmeyle yeniden denenir, tur sürer.
          log.warn('finalize_error', { job: candidate.job, error });
          await record(candidate.job, { kind: 'failed', reason: 'rpcError' }, now, {});
        }
      }
      lastSuccess = clock();
      metrics.lastRound.set(lastSuccess / 1000);
      if (candidates.length > 0) log.info('round', { evaluated: candidates.length, confirmed });
      return { evaluated: candidates.length, confirmed };
    },
    lastSuccessAt: () => lastSuccess,
    lastBalance: () => balance,
    oldestDueSeconds: () => oldestDue,
  };
}
