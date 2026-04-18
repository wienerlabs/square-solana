import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { padAddressList, padCategoryList, hashSolanaAddress, hashCategory } from './hash.js';
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

// Shape the HTTP request payload into the circuit input format and run snarkjs
// to produce a Groth16 proof. The payload mirrors what the legacy
// prover-service accepted so the existing agent-service and compliance-api
// callers do not need to change their request bodies.
export async function generateProof(request) {
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

  const circuitInput = {
    max_per_tx_lamports: String(request.max_per_transaction_lamports),
    max_daily_lamports: String(request.max_daily_spend_lamports),

    token_whitelist: tokens.values,
    token_whitelist_mask: tokens.mask,
    blocked_addresses: blocked.values,
    blocked_addresses_mask: blocked.mask,
    allowed_categories: categories.values,
    allowed_categories_mask: categories.mask,

    daily_spent_lamports: String(request.daily_spent_so_far_lamports),

    payment_amount_lamports: String(request.payment_amount_lamports),
    payment_token: await hashSolanaAddress(request.payment_token_mint),
    payment_recipient: await hashSolanaAddress(request.payment_recipient),
    payment_category: await hashCategory(request.payment_endpoint_category),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  const [isCompliantStr, journalDigestStr] = publicSignals;
  const encoded = encodeForGroth16Solana(proof, publicSignals);

  return {
    is_compliant: isCompliantStr === '1',
    journal_digest: journalDigestStr,
    groth16: encoded,
    // Raw snarkjs output is kept for debugging and off-chain verification.
    raw_proof: proof,
    raw_public: publicSignals,
  };
}
