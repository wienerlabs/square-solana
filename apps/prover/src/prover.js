import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import {
  padAddressList,
  padCategoryList,
  hashSolanaAddress,
  hashCategory,
  hashUuid,
  daysToBitmask,
  decodeAddress32,
  splitBytes,
} from './hash.js';
import { encodeForGroth16Solana } from './convert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTIFACTS_DIR = path.resolve(__dirname, '..', 'artifacts');
const WASM_PATH = path.join(ARTIFACTS_DIR, 'payment.wasm');
const ZKEY_PATH = path.join(ARTIFACTS_DIR, 'payment.zkey');

// Fixed list sizes must match the template parameters used in
// circuits/payment-prover/payment.circom:
//   component main = PaymentCompliance(MAX_WHITELIST, MAX_BLOCKED, MAX_CATEGORIES)
const MAX_WHITELIST = 10;
const MAX_BLOCKED = 10;
const MAX_CATEGORIES = 8;

// Validate that an incoming request carries every field the payment.circom
// circuit needs. Surface a clear error per missing field instead of letting
// snarkjs crash deep inside witness generation.
function validateRequest(req) {
  const required = [
    'policy_id',
    'operator_id',
    'max_daily_spend_lamports',
    'max_per_transaction_lamports',
    'allowed_endpoint_categories',
    'blocked_addresses',
    'token_whitelist',
    'payment_amount_lamports',
    'payment_token_mint',
    'payment_recipient',
    'payment_endpoint_category',
    'daily_spent_before_lamports',
    'current_unix_timestamp',
    // stripe_receipt_hash is OPTIONAL — defaults to '0' for Solana flow.
    // The MPP B-flow (Adım 8) sends a non-zero Poseidon-of-canonical-receipt
    // value the verify_mpp_payment_proof instruction will ed25519-check
    // against the compliance-api's authority signature.
  ];
  const missing = required.filter((k) => req[k] === undefined || req[k] === null);
  if (missing.length > 0) {
    throw new Error(`Missing required field(s): ${missing.join(', ')}`);
  }
}

// Shape an incoming HTTP payload into the witness inputs payment.circom expects.
// The payload mirrors the on-chain truth at proof time (recipient, amount,
// mint, daily_spent_before, current_unix_timestamp) — none of these may be
// fabricated by the caller because the verifier and the transfer-hook will
// cross-check them in Adım 5/6.
export async function generateProof(request) {
  validateRequest(request);

  const tokens = await padAddressList(
    request.token_whitelist ?? [],
    MAX_WHITELIST,
  );
  const blocked = await padAddressList(
    request.blocked_addresses ?? [],
    MAX_BLOCKED,
  );
  const categories = await padCategoryList(
    request.allowed_endpoint_categories ?? [],
    MAX_CATEGORIES,
  );

  // Time restriction. Default = inactive (no time gate). The circuit MUX
  // forces hash(time) == 0 when time_active == 0, so the off-chain backend's
  // computePolicyDataHash and the in-circuit hash agree.
  const tr = Array.isArray(request.time_restrictions) ? request.time_restrictions[0] : null;
  const timeActive = tr ? '1' : '0';
  const timeDaysBitmask = tr ? String(daysToBitmask(tr.allowed_days ?? [])) : '0';
  const timeStartHourUtc = tr ? String(tr.allowed_hours_start ?? 0) : '0';
  const timeEndHourUtc = tr ? String(tr.allowed_hours_end ?? 0) : '0';
  if (tr && tr.timezone && tr.timezone !== 'UTC') {
    throw new Error(`Only timezone='UTC' supported in MVP, got '${tr.timezone}'`);
  }

  // Split the payment recipient and token mint into 16+16 byte halves the
  // circuit will expose verbatim as public outputs (recipient_high/low,
  // token_mint_high/low). The on-chain verifier reads these directly off the
  // proof and compares them against the actual transfer instruction.
  const recipientBytes = decodeAddress32(request.payment_recipient);
  const tokenBytes = decodeAddress32(request.payment_token_mint);
  const [recipientHigh, recipientLow] = splitBytes(recipientBytes);
  const [tokenHigh, tokenLow] = splitBytes(tokenBytes);

  const operatorIdField = await hashSolanaAddress(request.operator_id);
  const policyIdField = await hashUuid(request.policy_id);
  const paymentCategoryField = await hashCategory(request.payment_endpoint_category);

  const circuitInput = {
    // Policy (private)
    max_per_tx_lamports: String(request.max_per_transaction_lamports),
    max_daily_lamports: String(request.max_daily_spend_lamports),
    token_whitelist: tokens.values,
    token_whitelist_mask: tokens.mask,
    blocked_addresses: blocked.values,
    blocked_addresses_mask: blocked.mask,
    allowed_categories: categories.values,
    allowed_categories_mask: categories.mask,
    payment_category: paymentCategoryField,
    operator_id_field: operatorIdField,
    policy_id_field: policyIdField,
    time_active: timeActive,
    time_days_bitmask: timeDaysBitmask,
    time_start_hour_utc: timeStartHourUtc,
    time_end_hour_utc: timeEndHourUtc,

    // Payment (mirrored to public outputs)
    recipient_high_in: recipientHigh.toString(),
    recipient_low_in: recipientLow.toString(),
    amount_lamports_in: String(request.payment_amount_lamports),
    token_mint_high_in: tokenHigh.toString(),
    token_mint_low_in: tokenLow.toString(),
    daily_spent_before_in: String(request.daily_spent_before_lamports),
    current_unix_timestamp_in: String(request.current_unix_timestamp),
    // Stripe receipt commitment (decimal field element string). Zero when
    // the proof is for a pure Solana payment.
    stripe_receipt_hash_in: String(request.stripe_receipt_hash ?? '0'),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  // publicSignals layout (matches payment.circom output order):
  //   [0] is_compliant
  //   [1] policy_data_hash
  //   [2] recipient_high
  //   [3] recipient_low
  //   [4] amount_lamports
  //   [5] token_mint_high
  //   [6] token_mint_low
  //   [7] daily_spent_before
  //   [8] current_unix_timestamp
  if (publicSignals.length !== 10) {
    throw new Error(
      `Circuit produced ${publicSignals.length} public signals, expected 10 — ` +
      `circuit and prover-service are out of sync.`
    );
  }
  const [
    isCompliantStr,
    policyDataHashStr,
    recipientHighStr,
    recipientLowStr,
    amountLamportsStr,
    tokenMintHighStr,
    tokenMintLowStr,
    dailySpentBeforeStr,
    currentUnixTimestampStr,
    stripeReceiptHashStr,
  ] = publicSignals;

  const encoded = encodeForGroth16Solana(proof, publicSignals);

  const policyDataHashHex = BigInt(policyDataHashStr)
    .toString(16)
    .padStart(64, '0');

  return {
    is_compliant: isCompliantStr === '1',
    policy_data_hash: policyDataHashStr,
    policy_data_hash_hex: policyDataHashHex,
    public_signals: {
      is_compliant: isCompliantStr,
      policy_data_hash: policyDataHashStr,
      recipient_high: recipientHighStr,
      recipient_low: recipientLowStr,
      amount_lamports: amountLamportsStr,
      token_mint_high: tokenMintHighStr,
      token_mint_low: tokenMintLowStr,
      daily_spent_before: dailySpentBeforeStr,
      current_unix_timestamp: currentUnixTimestampStr,
      stripe_receipt_hash: stripeReceiptHashStr,
    },
    groth16: encoded,
    raw_proof: proof,
    raw_public: publicSignals,

    // The verifier seeds the ProofRecord PDA by policy_data_hash, so callers
    // can derive the same PDA off-chain by hex-decoding policy_data_hash_hex.
    // proof_hash kept as an alias for legacy callers that recorded the field
    // under that name; it is the same 32-byte commitment.
    proof_hash: policyDataHashHex,
    verification_timestamp: new Date().toISOString(),
    receipt_bytes: Array.from(
      Buffer.concat([
        Buffer.from(encoded.proof_a, 'base64'),
        Buffer.from(encoded.proof_b, 'base64'),
        Buffer.from(encoded.proof_c, 'base64'),
      ]),
    ),
  };
}
