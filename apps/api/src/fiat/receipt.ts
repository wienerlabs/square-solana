// Kanonik Stripe makbuzu ve MPP attestation'ı (BE-25, ADR 0024 §3, ADR 0026). Makbuzun Poseidon commitment'ı
// Aperture compliance-api'nin `computeStripeReceiptHash`'iyle aynı düzendedir (alan sırası protokoldür):
//   alan(s)      = Poseidon(high, low); high/low, s'nin 32 bayta sıfırla doldurulmuş UTF-8 baytlarının yarıları
//   receiptHash  = Poseidon(alan(paymentIntent), amountMinor, alan(currency), alan(customer ?? ""), paidAt)
// Commitment release devresinin 12. sinyalidir (`stripe_receipt_hash`). MPP authority onu işe ve tutara bağlayan
// `mppAttestationMessage`'ı ed25519 ile imzalar; verifier imzayı Ed25519 precompile talimatından okur.
import { ed25519 } from '@noble/curves/ed25519.js';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { fieldToBytes32, poseidon, splitBytes32 } from '@squaresdk/solana-policy';
import { mppAttestationMessage } from '@squaresdk/solana-sdk';
import bs58 from 'bs58';

/** Kanonik makbuz: commitment'a giren alanlar. */
export interface CanonicalReceipt {
  readonly paymentIntent: string;
  /** Sent. */
  readonly amountMinor: number;
  /** ISO 4217, küçük harf. */
  readonly currency: string;
  readonly customer: string | null;
  /** Ödemenin (son charge'ın) unix saniyesi. */
  readonly paidAt: number;
}

const SLOT_BYTES = 32;

/** Metin alanı: 32 bayta sığmayan değer commitment'a giremez. */
function textField(value: string, what: string): bigint {
  const utf8 = new TextEncoder().encode(value);
  if (utf8.length > SLOT_BYTES) throw new Error(`${what} 32 baytı aşıyor`);
  const padded = new Uint8Array(SLOT_BYTES);
  padded.set(utf8);
  return poseidon(splitBytes32(padded));
}

/** Makbuzun Poseidon commitment'ı, 32 bayt big-endian. */
export function receiptHash(receipt: CanonicalReceipt): Uint8Array {
  if (!Number.isSafeInteger(receipt.amountMinor) || receipt.amountMinor <= 0) throw new Error('amountMinor geçersiz');
  if (!Number.isSafeInteger(receipt.paidAt) || receipt.paidAt <= 0) throw new Error('paidAt geçersiz');
  return fieldToBytes32(
    poseidon([
      textField(receipt.paymentIntent, 'paymentIntent'),
      BigInt(receipt.amountMinor),
      textField(receipt.currency, 'currency'),
      textField(receipt.customer ?? '', 'customer'),
      BigInt(receipt.paidAt),
    ]),
  );
}

/** Attestation: mesajın MPP authority imzası (base58). */
export function signAttestation(
  authority: Keypair,
  params: { job: PublicKey; receiptHash: Uint8Array; amount: bigint },
): string {
  const message = mppAttestationMessage({
    job: params.job,
    stripeReceiptHash: params.receiptHash,
    amount: params.amount,
  });
  return bs58.encode(ed25519.sign(message, authority.secretKey.subarray(0, 32)));
}
