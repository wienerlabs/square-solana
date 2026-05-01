import { buildPoseidon, type Poseidon } from 'circomlibjs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { config } from '../config.js';

let poseidonPromise: Promise<Poseidon> | null = null;

async function getPoseidon(): Promise<Poseidon> {
  if (!poseidonPromise) {
    poseidonPromise = buildPoseidon();
  }
  return poseidonPromise;
}

let cachedAuthority: Keypair | null = null;

function getAuthorityKeypair(): Keypair {
  if (!cachedAuthority) {
    const raw = config.mppAuthority.keypairBase58;
    let secretKeyBytes: Uint8Array;
    if (raw.startsWith('[')) {
      secretKeyBytes = new Uint8Array(JSON.parse(raw) as number[]);
    } else {
      secretKeyBytes = bs58.decode(raw);
    }
    if (secretKeyBytes.length !== 64) {
      throw new Error(
        `MPP_AUTHORITY_KEYPAIR_BASE58 must decode to 64 bytes (Solana keypair), got ${secretKeyBytes.length}`,
      );
    }
    cachedAuthority = Keypair.fromSecretKey(secretKeyBytes);
  }
  return cachedAuthority;
}

export function getAuthorityPublicKeyBase58(): string {
  return getAuthorityKeypair().publicKey.toBase58();
}

/**
 * The canonical Stripe receipt the on-chain verifier ultimately consumes.
 * Field order is part of the protocol — drift here invalidates every
 * previously persisted receipt because the Poseidon hash will not match.
 *
 * `paid_at_unix` pins the receipt to a specific second so an attacker who
 * leaks an old Stripe event cannot replay it as a fresh payment authorization.
 */
export interface CanonicalStripeReceipt {
  readonly stripe_payment_intent_id: string;
  readonly amount_cents: number;
  readonly currency: string;
  readonly customer: string;
  readonly paid_at_unix: number;
}

function utf8PadTo32(s: string): Buffer {
  const utf8 = Buffer.from(s, 'utf8');
  if (utf8.length > 32) {
    throw new Error(`field too long for 32-byte slot: ${s}`);
  }
  const out = Buffer.alloc(32);
  utf8.copy(out, 0);
  return out;
}

function splitBytes32(buf: Buffer): [bigint, bigint] {
  if (buf.length !== 32) {
    throw new Error(`splitBytes32: expected 32-byte buffer, got ${buf.length}`);
  }
  const high = BigInt('0x' + buf.subarray(0, 16).toString('hex'));
  const low = BigInt('0x' + buf.subarray(16, 32).toString('hex'));
  return [high, low];
}

async function hashStringField(
  poseidon: Poseidon,
  s: string,
): Promise<bigint> {
  const [high, low] = splitBytes32(utf8PadTo32(s));
  return BigInt(poseidon.F.toString(poseidon([high, low])));
}

/**
 * Computes the Poseidon commitment over the canonical Stripe receipt fields.
 * Returns the field element as a 64-char lowercase hex string (32 bytes
 * big-endian) so it lines up with how the ZK circuit will emit it as
 * public_inputs[9] in Adım 8b.
 *
 * Hashing layout:
 *   stripe_id_field   = Poseidon(splitBytes32(utf8_pad32(payment_intent_id)))
 *   currency_field    = Poseidon(splitBytes32(utf8_pad32(currency)))
 *   customer_field    = Poseidon(splitBytes32(utf8_pad32(customer || "")))
 *   stripe_receipt_hash = Poseidon([
 *     stripe_id_field,
 *     amount_cents,
 *     currency_field,
 *     customer_field,
 *     paid_at_unix,
 *   ])
 */
export async function computeStripeReceiptHash(
  receipt: CanonicalStripeReceipt,
): Promise<string> {
  const poseidon = await getPoseidon();
  const stripeIdField = await hashStringField(poseidon, receipt.stripe_payment_intent_id);
  const currencyField = await hashStringField(poseidon, receipt.currency);
  const customerField = await hashStringField(poseidon, receipt.customer);

  const out = poseidon([
    stripeIdField,
    BigInt(receipt.amount_cents),
    currencyField,
    customerField,
    BigInt(receipt.paid_at_unix),
  ]);
  const decimal = poseidon.F.toString(out);
  return BigInt(decimal).toString(16).padStart(64, '0');
}

/**
 * Signs the Poseidon hash (decoded as 32 raw bytes) with the compliance-api's
 * ed25519 authority keypair. Returns a base58-encoded 64-byte signature, the
 * same shape Solana ed25519 verify expects when consumed by the verifier
 * program in Adım 8c.
 */
export function signReceiptHash(hashHex: string): string {
  if (hashHex.length !== 64 || !/^[0-9a-f]+$/i.test(hashHex)) {
    throw new Error(`signReceiptHash: expected 64-char hex, got "${hashHex}"`);
  }
  const message = Buffer.from(hashHex, 'hex');
  const kp = getAuthorityKeypair();
  const sig = nacl.sign.detached(message, kp.secretKey);
  return bs58.encode(sig);
}
