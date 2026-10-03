// Teslim edilmiş job'un ispatını taze tutar (proof freshness). Escrow, ispat release anındaki
// zincir durumuyla (payee, net, mint, günlük sayaç) eşleşmiyorsa ya da süresi geçmişse ödemez;
// izleyici bunlardan biri değişince ispatı yeniden üretip bağlar.
import type { PublicKey } from '@solana/web3.js';
import type { BuildOptions, BuiltTx, SquareClient } from '@squaresdk/solana-sdk';
import type { PolicyDocument } from '@squaresdk/solana-types';
import type { PolicySalts } from './policy.js';
import type { Prover } from './prover.js';
import { buildSetComplianceProofTx } from './tx.js';
import { buildReleaseWitness, type ReleaseWitness } from './witness.js';

/** İzlemenin bittiği job durumları. */
const TERMINAL = new Set(['released', 'refunded', 'cancelled']);

export interface WatchJobProofParams {
  client: SquareClient;
  prover: Prover;
  job: PublicKey;
  policy: PolicyDocument;
  salts: PolicySalts;
  paymentCategory: string;
  /** Kurumun yetkilisi; tx'i imzalar. */
  authority: PublicKey;
  buildOptions: BuildOptions;
  /** İmzalayıp gönderir, imzayı döner. */
  submit: (tx: BuiltTx) => Promise<string>;
  /** Kontrol aralığı (ms). */
  intervalMs: number;
  /** İspat süresi dolmadan bu kadar saniye önce yenilenir. */
  refreshBeforeSecs: number;
  onError: (error: unknown) => void;
  onRefreshed?: (event: { signature: string; witness: ReleaseWitness; reason: string }) => void;
  /** İzleme kendiliğinden bitince (job bitti ya da ispat tüketildi) sebebiyle çağrılır. */
  onDone?: (reason: string) => void;
  /** Saat (unix saniyesi); verilmezse sistem saati. */
  now?: () => number;
}

/** Bayatlık sebebi; ispat tazeyse null. */
async function staleness(params: WatchJobProofParams, witness: ReleaseWitness): Promise<string | null> {
  const { client, job } = params;
  const proof = await client.verifier.fetch('releaseProof', client.pda.releaseProof(job)[0]);
  if (!proof) return 'ispat yok';
  if (!proof.payee.equals(witness.payee)) return 'payee değişti';
  if (!proof.mint.equals(witness.mint)) return 'mint değişti';
  if (BigInt(proof.netAmount.toString()) !== witness.netAmount) return 'net tutar değişti';
  if (BigInt(proof.dailySpentBefore.toString()) !== witness.dailySpentBefore) return 'günlük sayaç değişti';
  const config = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
  if (!config) throw new Error('escrow config bulunamadı');
  const age = witness.timestamp - proof.proofTimestamp.toNumber();
  if (age >= config.params.proofTimeoutSecs.toNumber() - params.refreshBeforeSecs) return 'süresi doluyor';
  return null;
}

/** İzlemeyi başlatır; durdurma fonksiyonu döner. Bir kontrol bitmeden yenisi başlamaz. */
export function watchJobProof(params: WatchJobProofParams): () => void {
  const { client, job } = params;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  const finish = (reason: string) => {
    stop();
    params.onDone?.(reason);
  };

  async function tick(): Promise<void> {
    const account = await client.escrow.fetch('job', job);
    if (!account) throw new Error(`job bulunamadı: ${job.toBase58()}`);
    const status = Object.keys(account.status)[0]!;
    if (TERMINAL.has(status)) return finish(`job ${status}`);
    if (status !== 'delivered') return;
    const proof = await client.verifier.fetch('releaseProof', client.pda.releaseProof(job)[0]);
    if (proof?.consumed) return finish('ispat tüketildi');
    const witness = await buildReleaseWitness({
      client,
      job,
      policy: params.policy,
      salts: params.salts,
      paymentCategory: params.paymentCategory,
      ...(params.now && { now: params.now() }),
    });
    const reason = await staleness(params, witness);
    if (!reason) return;
    const onChainPolicy = await client.policy.fetch('policy', account.policy!);
    const tx = await buildSetComplianceProofTx(
      client,
      {
        authority: params.authority,
        institution: onChainPolicy!.institution,
        policy: account.policy!,
        job,
        proof: await params.prover.prove(witness),
      },
      params.buildOptions,
    );
    const signature = await params.submit(tx);
    params.onRefreshed?.({ signature, witness, reason });
  }

  const loop = async () => {
    try {
      await tick();
    } catch (error) {
      params.onError(error);
    }
    if (!stopped) timer = setTimeout(loop, params.intervalMs);
  };
  timer = setTimeout(loop, 0);
  return stop;
}
