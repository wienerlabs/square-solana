// Teslim edilmiş job'un ispatını taze tutar (proof freshness). Escrow, ispat release anındaki zincir
// durumuyla (payee, net, mint, günlük sayaç) eşleşmiyorsa ya da release ispatın UTC gününde değilse
// ödemez (ADR 0012 §4, `checkFresh`); izleyici bunlardan biri değişince ispatı yeniden üretip bağlar.
import type { PublicKey } from '@solana/web3.js';
import type { BuildOptions, BuiltTx, SquareClient, VerifierAccounts } from '@squaresdk/solana-sdk';
import type { PolicyDocument } from '@squaresdk/solana-types';
import type { PolicySalts } from './policy.js';
import type { Prover } from './prover.js';
import { checkFresh, type Staleness } from './release.js';
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
  onError: (error: unknown) => void;
  onRefreshed?: (event: { signature: string; witness: ReleaseWitness; reason: string }) => void;
  /** İzleme kendiliğinden bitince (job bitti ya da ispat tüketildi) sebebiyle çağrılır. */
  onDone?: (reason: string) => void;
  /** Saat (unix saniyesi); verilmezse sistem saati. */
  now?: () => number;
}

const STALE_REASON: Readonly<Record<Staleness, string>> = {
  payee: 'payee değişti',
  netAmount: 'net tutar değişti',
  mint: 'mint değişti',
  day: 'gün değişti',
  dailyCounter: 'günlük sayaç değişti',
};

const big = (value: { toString(): string }) => BigInt(value.toString());

type VerifierProof = VerifierAccounts['releaseProof'];

/**
 * Bayatlık sebebi; ispat tazeyse null. Escrow'un kuralıyla (`checkFresh`): witness release'in şimdiki
 * hâlidir (payee, net, mint), sayaç politikanın kurumunun `OperatorState`'idir (witness'ınki gibi).
 */
async function staleness(
  client: SquareClient,
  proof: VerifierProof | null,
  institution: PublicKey,
  witness: ReleaseWitness,
): Promise<string | null> {
  if (!proof) return 'ispat yok';
  const operator = await client.verifier.fetch('operatorState', client.pda.operatorState(institution)[0]);
  const reason = checkFresh(
    {
      payee: proof.payee,
      netAmount: big(proof.netAmount),
      mint: proof.mint,
      dailySpentBefore: big(proof.dailySpentBefore),
      proofTimestamp: proof.proofTimestamp.toNumber(),
    },
    operator && { dayStartUnix: operator.dayStartUnix.toNumber(), dailySpent: big(operator.dailySpent) },
    { payee: witness.payee, netAmount: witness.netAmount, mint: witness.mint },
    witness.timestamp,
  );
  return reason && STALE_REASON[reason];
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
    // Fiat işin ispatını MPP attestation'ıyla `buildVerifyMppPaymentProofTx` bağlar (ADR 0024).
    if ('fiat' in account.rail) throw new Error(`fiat iş izlenmez, ispatı verify_mpp_payment_proof bağlar: ${job.toBase58()}`);
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
    const onChainPolicy = await client.policy.fetch('policy', account.policy!);
    if (!onChainPolicy) throw new Error(`politika hesabı bulunamadı: ${account.policy!.toBase58()}`);
    const reason = await staleness(client, proof, onChainPolicy.institution, witness);
    if (!reason) return;
    const tx = await buildSetComplianceProofTx(
      client,
      {
        authority: params.authority,
        institution: onChainPolicy.institution,
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
