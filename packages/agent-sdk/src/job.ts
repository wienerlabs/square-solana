// Görev → job akışı (Arc adım 4, 5): A2A sunucusunun kapısı job'un bu agent'a ve çağıranın kurumuna ait,
// açık ya da fonlanmış olduğunu ve spec hash'inin tuttuğunu denetler (docs/design/a2a.md §4). Burada
// agent'ın kendi koşulları denetlenir (spec, capability, fiyat, cüzdan, deadline), sonra:
// accept_job → WORKING → işleyici → teslimat yükleme → artefakt → submit_work → COMPLETED → (isteğe bağlı)
// list_claim. `onTask` yeniden başlatmada tekrar çağrılabilir: job zaten `accepted` ise kabul tekrarlanmaz,
// `delivered` ise yalnızca görev tamamlanır.
import { PublicKey, type Commitment } from '@solana/web3.js';
import type { TaskContext, TaskExecutor } from '@squaresdk/solana-a2a';
import type { BuildOptions, SquareClient, WalletLike } from '@squaresdk/solana-sdk';
import type { DeliveryReceipt, JobStatus } from '@squaresdk/solana-types';
import { AgentTxError, readJob, settledCommitment, type JobState, type TxSender } from './chain.js';
import {
  DeliveryUploadError,
  deliveryArtifact,
  normalizeDeliverable,
  verifyReceipt,
  type NormalizedDelivery,
} from './delivery.js';
import type {
  AgentCapability,
  AgentLogger,
  Admission,
  ClaimListing,
  DeliveryUploader,
  JobHandler,
  RetryOptions,
  TxOptions,
} from './types.js';

const BPS = 10_000n;
const GATE_LAG_GRACE_SECONDS = 60;
const DELIVERED: ReadonlySet<JobStatus> = new Set(['delivered', 'disputed', 'resolved', 'released', 'refunded']);
const ACCEPTED_OR_LATER: ReadonlySet<JobStatus> = new Set(['accepted', ...DELIVERED]);

export const DEFAULT_RETRY: RetryOptions = Object.freeze({
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  submitMarginSeconds: 30,
});

export class JobFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JobFailure';
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isPermanent = (error: unknown) =>
  error instanceof JobFailure ||
  (error instanceof AgentTxError && error.program !== null) ||
  (error instanceof DeliveryUploadError && !error.retryable);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface JobExecutorDeps {
  client: SquareClient;
  commitment: Commitment;
  sender: TxSender;
  wallet: WalletLike;
  capabilities: readonly AgentCapability[];
  handler: JobHandler;
  delivery: DeliveryUploader;
  autoListClaim?: { discountBps: number };
  tx: TxOptions;
  now: () => number;
  logger?: AgentLogger;
  onError: (error: unknown) => void;
  onClaimListed?: (listing: ClaimListing) => void;
  admit?: Admission;
  retry?: RetryOptions;
}

/** Nominal değerin `discountBps` altı; `list_claim` 0 < fiyat < nominal ister. */
export function claimPrice(amount: bigint, discountBps: number): bigint {
  return (amount * (BPS - BigInt(discountBps))) / BPS;
}

export function assertDiscountBps(discountBps: number): void {
  if (!Number.isInteger(discountBps) || discountBps < 1 || discountBps > 9_999) {
    throw new Error(`autoListClaim.discountBps 1 ile 9999 arasında tamsayı olmalı: ${discountBps}`);
  }
}

/** Görevi açan mesajın ilk `data` parçası; kapı bunun hash'ini job'un `spec_hash`'iyle denetledi. */
function specOf(context: TaskContext): unknown {
  return context.message.parts.find((part) => part.data !== undefined)?.data;
}

function capabilityOf(spec: unknown, capabilities: readonly AgentCapability[]): AgentCapability | string {
  const named =
    spec !== null && typeof spec === 'object' && !Array.isArray(spec)
      ? (spec as Record<string, unknown>).capability
      : undefined;
  if (named === undefined) {
    if (capabilities.length === 1) return capabilities[0]!;
    return `spec bir capability belirtmeli (${capabilities.map((c) => c.id).join(', ')})`;
  }
  if (typeof named !== 'string') return 'spec.capability metin olmalı';
  return capabilities.find((c) => c.id === named) ?? `bilinmeyen capability: ${named}`;
}

export function assertRetryOptions(retry: RetryOptions): void {
  const { minDelayMs, maxDelayMs, submitMarginSeconds } = retry;
  if (!Number.isSafeInteger(minDelayMs) || minDelayMs < 1) throw new Error('retry.minDelayMs pozitif tamsayı olmalı');
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < minDelayMs) {
    throw new Error('retry.maxDelayMs, retry.minDelayMs’ten küçük olmayan bir tamsayı olmalı');
  }
  if (!Number.isSafeInteger(submitMarginSeconds) || submitMarginSeconds < 0) {
    throw new Error('retry.submitMarginSeconds negatif olmayan tamsayı olmalı');
  }
}

export function createJobExecutor(deps: JobExecutorDeps): TaskExecutor {
  const { client, sender, wallet } = deps;
  const readCommitment = settledCommitment(deps.commitment);
  const retry = deps.retry ?? DEFAULT_RETRY;
  assertRetryOptions(retry);
  const options = (): BuildOptions => ({
    feePayer: wallet.publicKey,
    ...(deps.tx.computeUnitPrice !== undefined ? { computeUnitPrice: deps.tx.computeUnitPrice } : {}),
    ...(deps.tx.addressLookupTables ? { addressLookupTables: deps.tx.addressLookupTables } : {}),
  });
  const backoff = (failures: number) => {
    const base = Math.min(retry.minDelayMs * 2 ** Math.min(failures - 1, 30), retry.maxDelayMs);
    return Math.max(1, Math.round(base * (0.5 + Math.random() / 2)));
  };

  /** Kabulden önceki ret sebebi; kabul edilebilirse null. */
  function refusal(job: JobState, capability: AgentCapability): string | null {
    if (!job.agentWallet.equals(wallet.publicKey)) {
      return `job'un agent cüzdanı ${job.agentWallet.toBase58()}, bu agent ${wallet.publicKey.toBase58()} ile imzalıyor`;
    }
    if (job.amount < capability.price) {
      return `job tutarı ${job.amount}, ${capability.id} fiyatının (${capability.price}) altında`;
    }
    if (job.deadline - retry.submitMarginSeconds <= deps.now()) return 'job deadline geçmiş';
    return null;
  }

  async function listClaim(job: JobState): Promise<void> {
    if (!deps.autoListClaim) return;
    const price = claimPrice(job.amount, deps.autoListClaim.discountBps);
    if (price <= 0n || price >= job.amount) return;
    try {
      // Job başına tek listeleme; yeniden başlatmada var olan listeleme tekrarlanmaz.
      const existing = await client.escrow.fetch('claimListing', client.pda.claimListing(job.address)[0]);
      if (existing) return;
      const built = await client.flow.listClaim({ agent: wallet.publicKey, job: job.address, price }, options());
      const signature = await sender.send('list_claim', built, [wallet]);
      deps.logger?.info(`alacak listelendi: ${job.address.toBase58()} fiyat ${price} (${signature})`);
      deps.onClaimListed?.({ job: job.address, price, signature });
    } catch (error) {
      deps.onError(error);
    }
  }

  async function work(
    context: TaskContext,
    job: JobState,
    capability: AgentCapability,
    spec: unknown,
  ): Promise<NormalizedDelivery> {
    let output;
    try {
      output = await deps.handler({
        capability,
        spec,
        job,
        taskId: context.taskId,
        caller: context.caller,
        message: context.message,
        signal: context.signal,
        progress: (text) => context.working(text),
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new JobFailure(messageOf(error), { cause: error });
    }
    try {
      return normalizeDeliverable(output);
    } catch (error) {
      throw new JobFailure(messageOf(error), { cause: error });
    }
  }

  async function upload(job: JobState, delivery: NormalizedDelivery): Promise<DeliveryReceipt> {
    const receipt = await deps.delivery.upload({
      job: job.address,
      content: delivery.content,
      contentType: delivery.contentType,
    });
    try {
      return verifyReceipt(receipt, delivery);
    } catch (error) {
      throw new JobFailure(messageOf(error), { cause: error });
    }
  }

  return {
    async onTask(context) {
      const address = new PublicKey(context.job.address);
      const spec = specOf(context);
      let decided = false;
      let capability: AgentCapability | null = null;
      let output: NormalizedDelivery | null = null;
      let receipt: DeliveryReceipt | null = null;
      let resumed = false;
      let sending: JobStatus | null = null;
      let failures = 0;
      let deadline: number | null = null;

      let floor: JobStatus | null = null;
      let known: JobState | null = null;
      const admittedAt = deps.now();
      const gateAhead = () => context.job.status === 'funded' && deps.now() - admittedAt < GATE_LAG_GRACE_SECONDS;

      const capabilityFor = (): AgentCapability => {
        if (capability) return capability;
        const found = capabilityOf(spec, deps.capabilities);
        if (typeof found === 'string') throw new JobFailure(found);
        capability = found;
        return found;
      };

      for (;;) {
        if (context.signal.aborted) return;
        try {
          const job = known ?? (await readJob(client, address, readCommitment));
          known = null;
          if (!job) {
            if (deadline === null && !gateAhead()) throw new JobFailure(`job zincirde yok: ${context.job.address}`);
            throw new Error(`job zincirde okunamadı: ${context.job.address}`);
          }
          deadline = job.deadline;
          if (floor === 'accepted' && !ACCEPTED_OR_LATER.has(job.status) && job.status !== 'cancelled') {
            throw new Error(`zincir okuması geride: job ${job.status}, kabul onaylandı`);
          }
          if (ACCEPTED_OR_LATER.has(job.status)) floor = 'accepted';
          if (sending === 'funded' && ACCEPTED_OR_LATER.has(job.status)) sending = null;
          if (sending === 'accepted' && DELIVERED.has(job.status)) sending = null;

          if (DELIVERED.has(job.status)) {
            if (output && receipt && receipt.workHash.toLowerCase() === job.workHash) {
              await context.addArtifact(deliveryArtifact(output, receipt), { lastChunk: true });
            } else if (output && receipt) {
              deps.onError(
                new JobFailure(
                  `job zincirde başka bir teslimle (${job.workHash}) teslim edilmiş, yerel çıktı sunulmadı`,
                ),
              );
            }
            await context.complete(
              `job zincirde teslim edilmiş (${job.status}): workHash ${job.workHash}, deliveryUri ${job.deliveryUri}`,
            );
            if (job.status === 'delivered') await listClaim(job);
            return;
          }
          if (job.status === 'open') {
            if (gateAhead()) throw new Error('zincir okuması geride: job open, görev kapısı fonlanmış gördü');
            await context.reject('job fonlanmamış: kurum fund_job’dan sonra görevi yeniden açmalı');
            return;
          }
          if (job.status === 'funded') {
            if (!decided) {
              if (spec === undefined) {
                await context.reject('görevi açan mesaj job spec’ini (data parçası) taşımalı');
                return;
              }
              const found = capabilityOf(spec, deps.capabilities);
              if (typeof found === 'string') {
                await context.reject(found);
                return;
              }
              const reason =
                refusal(job, found) ?? (await deps.admit?.({ capability: found, job, spec, taskId: context.taskId }));
              if (reason) {
                await context.reject(reason);
                return;
              }
              capability = found;
              decided = true;
            }
            if (context.signal.aborted) return;
            sending = 'funded';
            const built = await client.flow.acceptJob({ agent: wallet.publicKey, job: address }, options());
            const signature = await sender.send('accept_job', built, [wallet]);
            sending = null;
            floor = 'accepted';
            failures = 0;
            deps.logger?.info(`job kabul edildi: ${address.toBase58()} (${signature})`);
            await context.working(`kabul edildi: accept_job ${signature}`);
            continue;
          }
          if (job.status !== 'accepted') throw new JobFailure(`job durumu ${job.status}: iş yapılamaz`);
          if (!job.agentWallet.equals(wallet.publicKey)) throw new JobFailure('job başka bir agent cüzdanına bağlı');
          const current = capabilityFor();
          if (!decided && !resumed) {
            resumed = true;
            await context.working('kabul edilmiş job sürdürülüyor');
          }
          if (job.deadline - retry.submitMarginSeconds <= deps.now()) {
            throw new JobFailure('job süresi doldu: teslim için zaman kalmadı');
          }
          output ??= await work(context, job, current, spec);
          if (context.signal.aborted) return;
          receipt ??= await upload(job, output);
          sending = 'accepted';
          const built = await client.flow.submitWork(
            {
              agent: wallet.publicKey,
              job: job.address,
              workHash: Buffer.from(receipt.workHash, 'hex'),
              deliveryUri: receipt.deliveryUri,
            },
            options(),
          );
          const signature = await sender.send('submit_work', built, [wallet]);
          sending = null;
          deps.logger?.info(`teslim edildi: ${job.address.toBase58()} (${signature})`);
          await context.addArtifact(deliveryArtifact(output, receipt), { lastChunk: true });
          await context.complete(`teslim edildi: submit_work ${signature}`);
          await listClaim(job);
          return;
        } catch (error) {
          if (context.signal.aborted) return;
          if (error instanceof AgentTxError && error.program !== null && sending !== null) {
            const fresh = await readJob(client, address, readCommitment).catch(() => null);
            const landed =
              fresh !== null &&
              ((sending === 'funded' && ACCEPTED_OR_LATER.has(fresh.status)) ||
                (sending === 'accepted' && DELIVERED.has(fresh.status)));
            if (landed) {
              floor = 'accepted';
              known = fresh;
              deps.onError(error);
              continue;
            }
            const unconfirmed =
              error.program === 'escrow' &&
              error.errorName?.toLowerCase() === 'invalidstatus' &&
              (fresh === null ||
                fresh.status === sending ||
                (floor === 'accepted' && !ACCEPTED_OR_LATER.has(fresh.status) && fresh.status !== 'cancelled'));
            if (!unconfirmed) throw error;
          } else if (isPermanent(error)) {
            throw error;
          }
          if (deadline !== null && deadline - retry.submitMarginSeconds <= deps.now()) {
            throw new JobFailure(`job süresi doldu: ${messageOf(error)}`, { cause: error });
          }
          deps.onError(error);
          failures += 1;
          await sleep(backoff(failures), context.signal);
        }
      }
    },
  };
}
