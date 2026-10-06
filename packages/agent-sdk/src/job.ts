// Görev → job akışı (Arc adım 4, 5): A2A sunucusunun kapısı job'un bu agent'a ve çağıranın kurumuna ait,
// açık ya da fonlanmış olduğunu ve spec hash'inin tuttuğunu denetler (docs/design/a2a.md §4). Burada
// agent'ın kendi koşulları denetlenir (spec, capability, fiyat, cüzdan, deadline), sonra:
// accept_job → WORKING → işleyici → teslimat yükleme → artefakt → submit_work → COMPLETED → (isteğe bağlı)
// list_claim. `onTask` yeniden başlatmada tekrar çağrılabilir: job zaten `accepted` ise kabul tekrarlanmaz,
// `delivered` ise yalnızca görev tamamlanır.
import { PublicKey } from '@solana/web3.js';
import type { TaskContext, TaskExecutor } from '@squaresdk/solana-a2a';
import type { BuildOptions, SquareClient, WalletLike } from '@squaresdk/solana-sdk';
import type { JobStatus } from '@squaresdk/solana-types';
import { readJob, type JobState, type TxSender } from './chain.js';
import { deliveryArtifact, normalizeDeliverable, verifyReceipt } from './delivery.js';
import type { AgentCapability, AgentLogger, ClaimListing, DeliveryUploader, JobHandler, TxOptions } from './types.js';

const BPS = 10_000n;
const DELIVERED: ReadonlySet<JobStatus> = new Set(['delivered', 'disputed', 'resolved', 'released', 'refunded']);

export interface JobExecutorDeps {
  client: SquareClient;
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

export function createJobExecutor(deps: JobExecutorDeps): TaskExecutor {
  const { client, sender, wallet } = deps;
  const options = (): BuildOptions => ({
    feePayer: wallet.publicKey,
    ...(deps.tx.computeUnitPrice !== undefined ? { computeUnitPrice: deps.tx.computeUnitPrice } : {}),
    ...(deps.tx.addressLookupTables ? { addressLookupTables: deps.tx.addressLookupTables } : {}),
  });

  /** Kabulden önceki ret sebebi; kabul edilebilirse null. */
  function refusal(job: JobState, capability: AgentCapability): string | null {
    if (!job.agentWallet.equals(wallet.publicKey)) {
      return `job'un agent cüzdanı ${job.agentWallet.toBase58()}, bu agent ${wallet.publicKey.toBase58()} ile imzalıyor`;
    }
    if (job.amount < capability.price) {
      return `job tutarı ${job.amount}, ${capability.id} fiyatının (${capability.price}) altında`;
    }
    if (job.deadline <= deps.now()) return 'job deadline geçmiş';
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

  /** Teslim edildiyse true; görev bu arada kesildiyse (iptal, kapanış) false. */
  async function deliver(
    context: TaskContext,
    job: JobState,
    capability: AgentCapability,
    spec: unknown,
  ): Promise<boolean> {
    const output = await deps.handler({
      capability,
      spec,
      job,
      taskId: context.taskId,
      caller: context.caller,
      message: context.message,
      signal: context.signal,
      progress: (text) => context.working(text),
    });
    if (context.signal.aborted) return false;
    const delivery = normalizeDeliverable(output);
    const receipt = verifyReceipt(
      await deps.delivery.upload({ job: job.address, content: delivery.content, contentType: delivery.contentType }),
      delivery,
    );
    await context.addArtifact(deliveryArtifact(delivery, receipt), { lastChunk: true });
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
    deps.logger?.info(`teslim edildi: ${job.address.toBase58()} (${signature})`);
    await context.complete(`teslim edildi: submit_work ${signature}`);
    return true;
  }

  return {
    async onTask(context) {
      const address = new PublicKey(context.job.address);
      const job = await readJob(client, address);
      if (!job) throw new Error(`job zincirde yok: ${context.job.address}`);
      if (DELIVERED.has(job.status)) {
        await context.complete(`job zincirde teslim edilmiş (${job.status})`);
        if (job.status === 'delivered') await listClaim(job);
        return;
      }
      const spec = specOf(context);
      if (spec === undefined) {
        await context.reject('görevi açan mesaj job spec’ini (data parçası) taşımalı');
        return;
      }
      const capability = capabilityOf(spec, deps.capabilities);
      if (typeof capability === 'string') {
        if (job.status === 'accepted') throw new Error(capability);
        await context.reject(capability);
        return;
      }
      if (job.status === 'open') {
        await context.reject('job fonlanmamış: kurum fund_job’dan sonra görevi yeniden açmalı');
        return;
      }
      if (job.status === 'funded') {
        const reason = refusal(job, capability);
        if (reason) {
          await context.reject(reason);
          return;
        }
        if (context.signal.aborted) return;
        const built = await client.flow.acceptJob({ agent: wallet.publicKey, job: address }, options());
        const signature = await sender.send('accept_job', built, [wallet]);
        deps.logger?.info(`job kabul edildi: ${address.toBase58()} (${signature})`);
        await context.working(`kabul edildi: accept_job ${signature}`);
      } else if (job.status === 'accepted') {
        if (!job.agentWallet.equals(wallet.publicKey)) throw new Error('job başka bir agent cüzdanına bağlı');
        await context.working('kabul edilmiş job sürdürülüyor');
      } else {
        throw new Error(`job durumu ${job.status}: iş yapılamaz`);
      }
      if (await deliver(context, job, capability, spec)) await listClaim(job);
    },
  };
}
