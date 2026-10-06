// Adım 7: ispatı job'a bağlayan `set_compliance_proof` tx'i (program sözleşmesi v0.2.0, yol A).
// Talimat ispatı ve üç sinyali taşır: refusal_code (0), net_amount (5), proof_timestamp (9); diğer
// sinyalleri verifier hesaplardan kendisi kurar. Fiat işte (BC-37, ADR 0024) `verify_mpp_payment_proof`:
// MPP authority'nin Ed25519 attestation'ı hemen önceki talimat, ispat makbuz commitment'ını (12) taşır.
import { SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, type PublicKey } from '@solana/web3.js';
import {
  mppAttestationInstruction,
  mppAttestationMessage,
  withComputeProfile,
  type BuildOptions,
  type BuiltTx,
  type SquareClient,
} from '@squaresdk/solana-sdk';
import type { ProveResponse } from '@squaresdk/solana-types';
import BN from 'bn.js';

/** Public sinyallerin sırası (release-circuit.md §2). */
export const SIGNAL = Object.freeze({ refusalCode: 0, netAmount: 5, timestamp: 9, stripeReceiptHash: 12 });

const bytes = (hex: string) => Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
const signal = (proof: ProveResponse, index: number) => BigInt(`0x${proof.publicInputs[index]!}`);

export async function buildSetComplianceProofTx(
  client: SquareClient,
  params: {
    /** Kurumun yetkilisi (anahtar ya da bağlı Squads vault'u). */
    authority: PublicKey;
    /** square_policy `Institution` PDA'sı. */
    institution: PublicKey;
    policy: PublicKey;
    job: PublicKey;
    proof: ProveResponse;
  },
  options: BuildOptions,
): Promise<BuiltTx> {
  const refusalCode = signal(params.proof, SIGNAL.refusalCode);
  if (refusalCode > 0xffffn) throw new Error(`refusal_code u16 değil: ${refusalCode}`);
  const ix = await client.verifier.program.methods
    .setComplianceProof(
      bytes(params.proof.proofA),
      bytes(params.proof.proofB),
      bytes(params.proof.proofC),
      Number(refusalCode),
      new BN(signal(params.proof, SIGNAL.netAmount).toString()),
      new BN(signal(params.proof, SIGNAL.timestamp).toString()),
    )
    .accountsStrict({
      payer: options.feePayer,
      authority: params.authority,
      config: client.pda.verifierConfig()[0],
      institution: params.institution,
      policy: params.policy,
      job: params.job,
      claimListing: client.pda.claimListing(params.job)[0],
      operatorState: client.pda.operatorState(params.institution)[0],
      releaseProof: client.pda.releaseProof(params.job)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  // Groth16 doğrulaması ~178 bin CU: talimat başına varsayılan 200 bine yakın olduğundan sınır profilden.
  return client.buildTx([ix], withComputeProfile(options, 'setComplianceProof'));
}

/**
 * Fiat iş (ADR 0024): Stripe ödemesini işe bağlayan tx. MPP authority'nin (`VerifierConfig.mpp_authority`)
 * `mppAttestationMessage({ job, stripeReceiptHash, amount })` üzerindeki imzası Ed25519 precompile talimatı
 * olarak `verify_mpp_payment_proof`'tan hemen önce gelir; makbuz commitment'ı ispatın 12. sinyalidir, tutar
 * job'unkidir. İspat uyumlu olmalı (`refusal_code` 0): ödeme yapılmıştır, ret iade edilemez.
 */
export async function buildVerifyMppPaymentProofTx(
  client: SquareClient,
  params: {
    /** Kurumun yetkilisi (anahtar ya da bağlı Squads vault'u). */
    authority: PublicKey;
    /** square_policy `Institution` PDA'sı. */
    institution: PublicKey;
    policy: PublicKey;
    job: PublicKey;
    proof: ProveResponse;
    /** MPP authority'nin attestation mesajı üzerindeki 64 baytlık ed25519 imzası. */
    attestationSignature: Uint8Array;
  },
  options: BuildOptions,
): Promise<BuiltTx> {
  if (signal(params.proof, SIGNAL.refusalCode) !== 0n) {
    throw new Error('MPP yolunda yalnızca uyumlu ispat bağlanır (refusal_code 0)');
  }
  const receipt = signal(params.proof, SIGNAL.stripeReceiptHash);
  if (receipt === 0n) throw new Error("ispatın makbuz commitment'ı (sinyal 12) sıfır: escrow release ispatı");
  const account = await client.escrow.fetch('job', params.job);
  if (!account) throw new Error(`job bulunamadı: ${params.job.toBase58()}`);
  if (!('fiat' in account.rail)) throw new Error(`job fiat rayında değil: ${params.job.toBase58()}`);
  const config = await client.verifier.fetch('verifierConfig', client.pda.verifierConfig()[0]);
  if (!config) throw new Error('verifier config bulunamadı');
  const stripeReceiptHash = Uint8Array.from(bytes(params.proof.publicInputs[SIGNAL.stripeReceiptHash]!));
  const message = mppAttestationMessage({
    job: params.job,
    stripeReceiptHash,
    amount: BigInt(account.amount.toString()),
  });
  const attestation = mppAttestationInstruction({
    authority: config.mppAuthority,
    message,
    signature: params.attestationSignature,
  });
  const ix = await client.verifier.program.methods
    .verifyMppPaymentProof(
      bytes(params.proof.proofA),
      bytes(params.proof.proofB),
      bytes(params.proof.proofC),
      Array.from(stripeReceiptHash),
      new BN(signal(params.proof, SIGNAL.timestamp).toString()),
    )
    .accountsStrict({
      payer: options.feePayer,
      authority: params.authority,
      config: client.pda.verifierConfig()[0],
      institution: params.institution,
      policy: params.policy,
      job: params.job,
      operatorState: client.pda.operatorState(params.institution)[0],
      releaseProof: client.pda.releaseProof(params.job)[0],
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  // Attestation doğrudan verify'dan önce: compute budget talimatları buildTx'te en başa eklenir.
  return client.buildTx([attestation, ix], withComputeProfile(options, 'verifyMppPaymentProof'));
}
