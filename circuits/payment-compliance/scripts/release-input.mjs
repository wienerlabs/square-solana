// Build witness inputs for payment.circom (ReleaseCompliance), and evaluate the
// same statement outside the circuit.
//
// `evaluate` is a second, independent implementation of the seven rules and the
// policy commitment, written from docs/design/release-circuit.md rather than
// from the circuit. The tests hold the circuit's public outputs to it, so a test
// never compares the circuit with itself. Policy tooling (BE-35 and onwards)
// must produce the same list entries and the same commitment byte for byte.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { buildPoseidon } from 'circomlibjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');

export const MAX_WHITELIST = 10;
export const MAX_BLOCKED = 10;
export const MAX_CATEGORIES = 8;

// The verifier reads these positionally; the order is part of the contract
// between the circuit, the prover and square_verifier.
export const PUBLIC_SIGNALS = Object.freeze([
  'refusal_code',
  'policy_commitment',
  'daily_ceiling',
  'payee_high',
  'payee_low',
  'net_amount',
  'mint_high',
  'mint_low',
  'daily_spent_before',
  'current_unix_timestamp',
  'job_high',
  'job_low',
  'stripe_receipt_hash',
]);

// ReleaseProof.refusal_code: one bit per broken rule, 0 when compliant.
export const REFUSAL = Object.freeze({
  PER_TX: 1,
  DAILY_PRIVATE: 2,
  MINT_NOT_ALLOWED: 4,
  PAYEE_BLOCKED: 8,
  CATEGORY_NOT_ALLOWED: 16,
  OUTSIDE_TIME_WINDOW: 32,
  DAILY_CEILING: 64,
});

export const refusalNames = (code) =>
  Object.entries(REFUSAL).filter(([, bit]) => (Number(code) & bit) !== 0).map(([name]) => name);

let poseidon = null;
export async function getPoseidon() {
  if (!poseidon) poseidon = await buildPoseidon();
  return poseidon;
}

async function hash(values) {
  const p = await getPoseidon();
  return p.F.toObject(p(values.map(BigInt)));
}

// ------------------------------------------------------------------ addresses

export const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((x) => Buffer.from(x)))).digest();

// high = bytes 0..15, low = bytes 16..31, each big-endian: the split the
// verifier applies to the 32 bytes of an address.
export function splitBytes32(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length !== 32) throw new Error(`expected 32 bytes, got ${buf.length}`);
  return [BigInt(`0x${buf.subarray(0, 16).toString('hex')}`), BigInt(`0x${buf.subarray(16).toString('hex')}`)];
}

export const addressHalves = (address) => splitBytes32(bs58.decode(address));

// List entry and lookup key of an address: Poseidon(high, low).
export const addressField = async (address) => hash(addressHalves(address));

// Category: UTF-8 bytes zero-padded to 32, then Poseidon(high, low).
export async function categoryField(category) {
  const utf8 = Buffer.from(category, 'utf8');
  if (utf8.length === 0 || utf8.length > 32) throw new Error(`category must be 1..32 bytes: ${category}`);
  const padded = Buffer.alloc(32);
  utf8.copy(padded);
  return hash(splitBytes32(padded));
}

export function isOnCurve(bytes) {
  try {
    ed25519.Point.fromBytes(Uint8Array.from(bytes));
    return true;
  } catch {
    return false;
  }
}

// Solana's find_program_address.
export function findPda(programId, seeds) {
  const program = bs58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(...seeds, [bump], program, 'ProgramDerivedAddress');
    if (!isOnCurve(candidate)) return { address: bs58.encode(candidate), bump };
  }
  throw new Error('no viable bump');
}

// Test keys: an Ed25519 public key whose seed is derived from a label. Real
// keys, reproducible, and nobody's — the seed is in this file.
export const keyFromLabel = (label) =>
  bs58.encode(ed25519.getPublicKey(sha256('square-solana/bc-19/', label)));

// Program ids come from the committed IDLs (BC-44), the same place clients
// read them from until BC-09 assigns Square's own.
export function programId(name) {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'idl', `${name}.json`), 'utf8')).address;
}

// --------------------------------------------------------------------- world

// Circle's devnet USDC mint and the native SOL mint: real mints, used as the
// whitelisted settlement mint and a mint outside the whitelist.
export const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export function world() {
  const escrow = programId('square_escrow_contract');
  const policy = programId('square_policy_contract');
  const institutionWallet = keyFromLabel('institution wallet');
  const institution = findPda(policy, ['institution', bs58.decode(institutionWallet)]).address;
  const policyId = sha256('policy: research procurement');
  const specHash = sha256('job spec: market research report');
  const job = findPda(escrow, ['job', bs58.decode(institutionWallet), specHash]).address;
  return {
    escrow,
    policy,
    institutionWallet,
    institution,
    policyId,
    job,
    agentWallet: keyFromLabel('agent wallet'),
    claimBuyer: keyFromLabel('claim buyer'),
    blockedWallet: keyFromLabel('sanctioned wallet'),
  };
}

// Salts are field elements well above 2^128 derived from a label. They are not
// secret and are not meant to be: a real policy draws them from a secret.
export async function testSalts(label) {
  const p = await getPoseidon();
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(p.F.toObject(p.F.e(BigInt(`0x${sha256('salt/', label, '/', String(i)).toString('hex')}`))).toString());
  }
  return out;
}

function pad(values, max) {
  if (values.length > max) throw new Error(`list of ${values.length} exceeds the circuit maximum of ${max}`);
  return [...values.map(String), ...Array(max - values.length).fill('0')];
}

const USDC = 1_000_000n; // 6 decimals

// 2026-09-21T14:13:20Z, a Monday: day_of_week 0, hour 14.
export const TIMESTAMP = 1790000000;

// A release the default policy allows. Override any piece per scenario.
export async function buildInput(overrides = {}) {
  const w = world();
  const o = {
    maxPerTx: 100n * USDC,
    maxDaily: 500n * USDC,
    dailyCeiling: 1000n * USDC,
    tokenWhitelist: [USDC_DEVNET],
    blockedAddresses: [w.blockedWallet],
    allowedCategories: ['research', 'data'],
    paymentCategory: 'research',
    timeActive: 1,
    timeDaysBitmask: 0b0011111, // Monday..Friday
    timeStartHourUtc: 9,
    timeEndHourUtc: 17,
    salts: null,
    payee: w.agentWallet,
    netAmount: 25n * USDC,
    mint: USDC_DEVNET,
    dailySpentBefore: 200n * USDC,
    timestamp: TIMESTAMP,
    job: w.job,
    stripeReceiptHash: 0n,
    ...overrides,
  };

  const [payeeHigh, payeeLow] = addressHalves(o.payee);
  const [mintHigh, mintLow] = addressHalves(o.mint);
  const [jobHigh, jobLow] = addressHalves(o.job);

  return {
    max_per_tx: String(o.maxPerTx),
    max_daily: String(o.maxDaily),
    token_whitelist: pad(await Promise.all(o.tokenWhitelist.map(addressField)), MAX_WHITELIST),
    blocked_addresses: pad(await Promise.all(o.blockedAddresses.map(addressField)), MAX_BLOCKED),
    allowed_categories: pad(await Promise.all(o.allowedCategories.map(categoryField)), MAX_CATEGORIES),
    payment_category: String(await categoryField(o.paymentCategory)),
    operator_id_field: String(await addressField(w.institution)),
    policy_id_field: String(await hash(splitBytes32(w.policyId))),
    policy_salts: o.salts ?? (await testSalts('default policy')),
    time_active: String(o.timeActive),
    time_days_bitmask: String(o.timeDaysBitmask),
    time_start_hour_utc: String(o.timeStartHourUtc),
    time_end_hour_utc: String(o.timeEndHourUtc),
    daily_ceiling_in: String(o.dailyCeiling),
    payee_high_in: String(payeeHigh),
    payee_low_in: String(payeeLow),
    net_amount_in: String(o.netAmount),
    mint_high_in: String(mintHigh),
    mint_low_in: String(mintLow),
    daily_spent_before_in: String(o.dailySpentBefore),
    current_unix_timestamp_in: String(o.timestamp),
    job_high_in: String(jobHigh),
    job_low_in: String(jobLow),
    stripe_receipt_hash_in: String(o.stripeReceiptHash),
  };
}

// ---------------------------------------------------------------- evaluation

// The policy commitment, longhand:
//   leaf[i] = Poseidon(i, salt[i], value[i]);  commitment = Poseidon(leaf[0..7])
export async function policyCommitment(input) {
  const values = [
    BigInt(input.max_daily),
    BigInt(input.max_per_tx),
    BigInt(input.operator_id_field),
    BigInt(input.policy_id_field),
    await hash(input.allowed_categories),
    await hash(input.blocked_addresses),
    await hash(input.token_whitelist),
    BigInt(input.time_active) === 0n
      ? 0n
      : await hash([input.time_active, input.time_days_bitmask, input.time_start_hour_utc, input.time_end_hour_utc]),
  ];
  const leaves = [];
  for (let i = 0; i < 8; i++) leaves.push(await hash([BigInt(i), BigInt(input.policy_salts[i]), values[i]]));
  return hash(leaves);
}

// The public signals an honest witness produces for `input`, by name.
export async function evaluate(input) {
  const big = (k) => BigInt(input[k]);
  const net = big('net_amount_in');
  const spent = big('daily_spent_before_in');
  const ts = big('current_unix_timestamp_in');
  const payeeKey = await hash([big('payee_high_in'), big('payee_low_in')]);
  const mintKey = await hash([big('mint_high_in'), big('mint_low_in')]);

  const day = ts / 86400n;
  const hour = (ts % 86400n) / 3600n;
  const weekday = (day + 3n) % 7n; // Monday = 0
  const inWindow =
    ((big('time_days_bitmask') >> weekday) & 1n) === 1n
    && hour >= big('time_start_hour_utc')
    && hour <= big('time_end_hour_utc');

  let code = 0;
  if (net > big('max_per_tx')) code |= REFUSAL.PER_TX;
  if (spent + net > big('max_daily')) code |= REFUSAL.DAILY_PRIVATE;
  if (!input.token_whitelist.map(BigInt).includes(mintKey)) code |= REFUSAL.MINT_NOT_ALLOWED;
  if (input.blocked_addresses.map(BigInt).includes(payeeKey)) code |= REFUSAL.PAYEE_BLOCKED;
  if (!input.allowed_categories.map(BigInt).includes(big('payment_category'))) code |= REFUSAL.CATEGORY_NOT_ALLOWED;
  if (big('time_active') === 1n && !inWindow) code |= REFUSAL.OUTSIDE_TIME_WINDOW;
  if (spent + net > big('daily_ceiling_in')) code |= REFUSAL.DAILY_CEILING;

  return {
    refusal_code: String(code),
    policy_commitment: String(await policyCommitment(input)),
    daily_ceiling: input.daily_ceiling_in,
    payee_high: input.payee_high_in,
    payee_low: input.payee_low_in,
    net_amount: input.net_amount_in,
    mint_high: input.mint_high_in,
    mint_low: input.mint_low_in,
    daily_spent_before: input.daily_spent_before_in,
    current_unix_timestamp: input.current_unix_timestamp_in,
    job_high: input.job_high_in,
    job_low: input.job_low_in,
    stripe_receipt_hash: input.stripe_receipt_hash_in,
  };
}

export const toArray = (named) => PUBLIC_SIGNALS.map((k) => named[k]);
