// Stripe MPP fiat rayının attestation'ı (BC-37, ADR 0024). Fiat işte ödeme Stripe ile yapılır; doğrulanmış Stripe
// webhook'unu alan servis (MPP authority, `VerifierConfig.mpp_authority`) makbuzun Poseidon commitment'ını işe ve
// tutara bağlayan mesajı ed25519 ile imzalar. Verifier'ın `verify_mpp_payment_proof`'u imzayı hemen önceki Ed25519
// precompile talimatından okur. Zincirdeki karşılığı `square_common::mpp`; iki uygulamanın uyumu ortak vektörlerle
// denetlenir (`crates/square-common/tests/fixtures/mpp-attestation-vectors.json`).
import { Ed25519Program, type PublicKey, type TransactionInstruction } from '@solana/web3.js';

/** Mesajın alan ayırıcısı (sürümlü). */
export const MPP_ATTESTATION_DOMAIN = 'square/mpp-attestation/v1';

const DOMAIN_BYTES = new TextEncoder().encode(MPP_ATTESTATION_DOMAIN);

/** Mesajın uzunluğu: ayırıcı, job, makbuz commitment'ı ve tutar (u64). */
export const MPP_ATTESTATION_MESSAGE_LENGTH = DOMAIN_BYTES.length + 32 + 32 + 8;

/**
 * İmzalanan mesaj: `"square/mpp-attestation/v1" ‖ job ‖ stripeReceiptHash ‖ amount (u64, little-endian)`.
 * `amount` işin tutarıdır (settlement mint'inin taban birimi); verifier job'daki tutarla kurar.
 */
export function mppAttestationMessage(params: {
  job: PublicKey;
  stripeReceiptHash: Uint8Array;
  amount: bigint;
}): Uint8Array {
  const { job, stripeReceiptHash, amount } = params;
  if (stripeReceiptHash.length !== 32) {
    throw new Error(`stripeReceiptHash 32 bayt olmalı, ${stripeReceiptHash.length} bayt`);
  }
  if (stripeReceiptHash.every((byte) => byte === 0)) throw new Error('stripeReceiptHash sıfır olamaz');
  if (amount <= 0n || amount >= 2n ** 64n) throw new Error(`amount u64 aralığı dışında ya da sıfır: ${amount}`);
  const message = new Uint8Array(MPP_ATTESTATION_MESSAGE_LENGTH);
  message.set(DOMAIN_BYTES, 0);
  message.set(job.toBytes(), DOMAIN_BYTES.length);
  message.set(stripeReceiptHash, DOMAIN_BYTES.length + 32);
  new DataView(message.buffer).setBigUint64(DOMAIN_BYTES.length + 64, amount, true);
  return message;
}

/**
 * MPP authority'nin imzasını taşıyan Ed25519 precompile talimatı. `verify_mpp_payment_proof`'tan hemen önce
 * gelmelidir; anahtar, imza ve mesaj talimatın kendi verisindedir.
 */
export function mppAttestationInstruction(params: {
  authority: PublicKey;
  message: Uint8Array;
  signature: Uint8Array;
}): TransactionInstruction {
  if (params.message.length !== MPP_ATTESTATION_MESSAGE_LENGTH) {
    throw new Error(`mesaj ${MPP_ATTESTATION_MESSAGE_LENGTH} bayt olmalı, ${params.message.length} bayt`);
  }
  if (params.signature.length !== 64) throw new Error(`imza 64 bayt olmalı, ${params.signature.length} bayt`);
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: params.authority.toBytes(),
    message: params.message,
    signature: params.signature,
  });
}
