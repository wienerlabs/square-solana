#!/usr/bin/env node
// Generates the JSON witness inputs for payment.circom and pins the expected
// public outputs (in particular policy_data_hash) so we can verify that the
// circuit's commitment matches what services/policy-service computes for the
// same policy. Anything that fails to match here breaks Adım 5 (verifier
// will reject every proof).

import { buildPoseidon } from 'circomlibjs';
import bs58 from 'bs58';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'test-inputs');
mkdirSync(OUT_DIR, { recursive: true });

// Circuit parameters MUST match payment.circom and
// services/policy-service/src/utils/merkle.ts.
const MAX_WHITELIST = 10;
const MAX_BLOCKED = 10;
const MAX_CATEGORIES = 8;

const poseidon = await buildPoseidon();
const F = poseidon.F;
const fieldStr = (x) => F.toString(x);

function splitPubkey32(buf) {
  if (buf.length !== 32) throw new Error(`expected 32 bytes, got ${buf.length}`);
  const high = BigInt('0x' + Buffer.from(buf).subarray(0, 16).toString('hex'));
  const low = BigInt('0x' + Buffer.from(buf).subarray(16, 32).toString('hex'));
  return [high, low];
}

function decodeAddr32(base58) {
  const raw = bs58.decode(base58);
  if (raw.length !== 32) {
    throw new Error(`address must decode to 32 bytes: ${base58} (got ${raw.length})`);
  }
  return Buffer.from(raw);
}

function hashAddrField(base58) {
  const [high, low] = splitPubkey32(decodeAddr32(base58));
  return fieldStr(poseidon([high, low]));
}

function hashCategoryField(category) {
  const utf8 = Buffer.from(category, 'utf8');
  if (utf8.length > 32) throw new Error(`category too long: ${category}`);
  const padded = Buffer.alloc(32);
  utf8.copy(padded, 0);
  const [high, low] = splitPubkey32(padded);
  return fieldStr(poseidon([high, low]));
}

function hashUuidField(uuid) {
  const cleaned = uuid.replace(/-/g, '');
  if (cleaned.length !== 32 || !/^[0-9a-f]+$/i.test(cleaned)) {
    throw new Error(`invalid UUID: ${uuid}`);
  }
  const raw16 = Buffer.from(cleaned, 'hex');
  const padded = Buffer.alloc(32);
  raw16.copy(padded, 0);
  const [high, low] = splitPubkey32(padded);
  return fieldStr(poseidon([high, low]));
}

function padFieldList(fields, maxLen) {
  if (fields.length > maxLen) throw new Error('list overflow');
  const values = [...fields];
  const mask = fields.map(() => '1');
  while (values.length < maxLen) {
    values.push('0');
    mask.push('0');
  }
  return { values, mask };
}

// =============================================================================
// Build a sample compliant fixture. The values below are real Solana devnet
// USDC + a placeholder operator pubkey, NOT random literals — every input
// resolves through the same Poseidon path that the backend takes.
// =============================================================================

// Real-shaped 32-byte Solana pubkeys, encoded as base58. Generating the
// recipient and the blocked address from deterministic byte buffers keeps
// the fixture reproducible without needing on-the-fly key generation.
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const OPERATOR_ID = 'HQgVTSHrBRRQ9TwYSv7gZF3vmTMa6u2yNwZM7b2zFcnq';
const POLICY_ID_UUID = '05142133-f480-489f-85b4-eee1fda7ec20';
function encodeFixedAddr(byteValue) {
  return bs58.encode(Buffer.alloc(32, byteValue));
}
const RECIPIENT = encodeFixedAddr(0x11);   // 32 bytes of 0x11
const BLOCKED_BAD = encodeFixedAddr(0xee); // 32 bytes of 0xEE

const NOW_UNIX = 1735689600; // 2025-01-01 00:00:00 UTC, deterministic for tests

function buildBaseInputs() {
  const tokens = padFieldList([hashAddrField(USDC_DEVNET)], MAX_WHITELIST);
  const blocked = padFieldList([hashAddrField(BLOCKED_BAD)], MAX_BLOCKED);
  const cats = padFieldList([hashCategoryField('compute')], MAX_CATEGORIES);

  const recipientBytes = decodeAddr32(RECIPIENT);
  const tokenBytes = decodeAddr32(USDC_DEVNET);
  const [recipientHigh, recipientLow] = splitPubkey32(recipientBytes);
  const [tokenHigh, tokenLow] = splitPubkey32(tokenBytes);

  return {
    // policy (private)
    max_per_tx_lamports: '10000000',
    max_daily_lamports: '100000000',
    token_whitelist: tokens.values,
    token_whitelist_mask: tokens.mask,
    blocked_addresses: blocked.values,
    blocked_addresses_mask: blocked.mask,
    allowed_categories: cats.values,
    allowed_categories_mask: cats.mask,
    payment_category: hashCategoryField('compute'),
    operator_id_field: hashAddrField(OPERATOR_ID),
    policy_id_field: hashUuidField(POLICY_ID_UUID),
    time_active: '0',
    time_days_bitmask: '0',
    time_start_hour_utc: '0',
    time_end_hour_utc: '0',

    // payment (mirrored to public outputs)
    recipient_high_in: recipientHigh.toString(),
    recipient_low_in: recipientLow.toString(),
    amount_lamports_in: '5000000',
    token_mint_high_in: tokenHigh.toString(),
    token_mint_low_in: tokenLow.toString(),
    daily_spent_before_in: '50000000',
    current_unix_timestamp_in: NOW_UNIX.toString(),
    // Pure Solana flow — no Stripe receipt to attest. The MPP B-flow
    // generator script lives separately so this fixture stays single-purpose.
    stripe_receipt_hash_in: '0',
  };
}

function expectedPolicyDataHash(input) {
  const catList = fieldStr(poseidon(input.allowed_categories.map(BigInt)));
  const blockedList = fieldStr(poseidon(input.blocked_addresses.map(BigInt)));
  const tokensList = fieldStr(poseidon(input.token_whitelist.map(BigInt)));
  const timeFieldRaw = fieldStr(poseidon([
    BigInt(input.time_active),
    BigInt(input.time_days_bitmask),
    BigInt(input.time_start_hour_utc),
    BigInt(input.time_end_hour_utc),
  ]));
  const timeField =
    input.time_active === '0' ? '0' : timeFieldRaw;
  const finalHash = fieldStr(poseidon([
    BigInt(input.max_daily_lamports),
    BigInt(input.max_per_tx_lamports),
    BigInt(input.operator_id_field),
    BigInt(input.policy_id_field),
    BigInt(catList),
    BigInt(blockedList),
    BigInt(tokensList),
    BigInt(timeField),
  ]));
  return finalHash;
}

const okCompliant = buildBaseInputs();
const okExpectedHash = expectedPolicyDataHash(okCompliant);

const badAmount = { ...buildBaseInputs(), amount_lamports_in: '20000000' }; // > 10 USDC cap
const badToken = { ...buildBaseInputs() };
{
  const fake = decodeAddr32(encodeFixedAddr(0x55));
  const [h, l] = splitPubkey32(fake);
  badToken.token_mint_high_in = h.toString();
  badToken.token_mint_low_in = l.toString();
}
const badBlocked = { ...buildBaseInputs() };
{
  const blockedBytes = decodeAddr32(BLOCKED_BAD);
  const [h, l] = splitPubkey32(blockedBytes);
  badBlocked.recipient_high_in = h.toString();
  badBlocked.recipient_low_in = l.toString();
}

writeFileSync(
  resolve(OUT_DIR, 'ok_compliant.json'),
  JSON.stringify(okCompliant, null, 2),
);
writeFileSync(
  resolve(OUT_DIR, 'ok_compliant.expected.json'),
  JSON.stringify(
    {
      is_compliant: '1',
      policy_data_hash: okExpectedHash,
      recipient_high: okCompliant.recipient_high_in,
      recipient_low: okCompliant.recipient_low_in,
      amount_lamports: okCompliant.amount_lamports_in,
      token_mint_high: okCompliant.token_mint_high_in,
      token_mint_low: okCompliant.token_mint_low_in,
      daily_spent_before: okCompliant.daily_spent_before_in,
      current_unix_timestamp: okCompliant.current_unix_timestamp_in,
    },
    null,
    2,
  ),
);

writeFileSync(
  resolve(OUT_DIR, 'bad_amount_exceeds_per_tx.json'),
  JSON.stringify(badAmount, null, 2),
);

writeFileSync(
  resolve(OUT_DIR, 'bad_token_not_whitelisted.json'),
  JSON.stringify(badToken, null, 2),
);

writeFileSync(
  resolve(OUT_DIR, 'bad_recipient_blocked.json'),
  JSON.stringify(badBlocked, null, 2),
);

console.log('wrote test inputs to', OUT_DIR);
console.log('expected policy_data_hash for ok_compliant:', okExpectedHash);
