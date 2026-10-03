// Test fixture: circuits/payment-compliance/scripts/release-input.mjs'teki dünya ve senaryolar
// (devrenin test-inputs/ dosyaları bunlardan üretildi). Anahtarlar etiketten türetilen gerçek
// Ed25519 anahtarlarıdır; salt'lar etiketten türetilir ve sır değildir.
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import type { PolicyDocument } from '@squaresdk/solana-types';
import { BN254_R } from '../../src/fields.js';
import type { ReleaseFacts } from '../../src/witness.js';

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export const CIRCUIT_DIR = new URL('../../../../circuits/payment-compliance/', import.meta.url);
export const readCircuitJson = (path: string) => JSON.parse(readFileSync(new URL(path, CIRCUIT_DIR), 'utf8'));

const keyFromLabel = (label: string) =>
  new PublicKey(ed25519.getPublicKey(sha256(cat(enc('square-solana/bc-19/'), enc(label)))));

export const USDC_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = 1_000_000n;
const HOUR = 3600;
const DAY = 86_400;
export const TIMESTAMP = 1_790_000_000;

const institutionWallet = keyFromLabel('institution wallet');
const policyId = sha256(enc('policy: research procurement'));
export const world = {
  institutionWallet,
  institution: PublicKey.findProgramAddressSync(
    [enc('institution'), institutionWallet.toBytes()],
    new PublicKey(SQUARE_IDLS.policy.address),
  )[0],
  policyId,
  job: PublicKey.findProgramAddressSync(
    [enc('job'), institutionWallet.toBytes(), sha256(enc('job spec: market research report'))],
    new PublicKey(SQUARE_IDLS.escrow.address),
  )[0],
  agentWallet: keyFromLabel('agent wallet'),
  claimBuyer: keyFromLabel('claim buyer'),
  blockedWallet: keyFromLabel('sanctioned wallet'),
};

export const testSalts = (label: string) =>
  Array.from(
    { length: 8 },
    (_, i) => BigInt(`0x${hex(sha256(cat(enc('salt/'), enc(label), enc('/'), enc(String(i)))))}`) % BN254_R,
  );

interface Overrides {
  maxPerTx?: bigint;
  maxDaily?: bigint;
  dailyCeiling?: bigint;
  timeActive?: 0;
  paymentCategory?: string;
  payee?: PublicKey;
  netAmount?: bigint;
  mint?: PublicKey;
  dailySpentBefore?: bigint;
  timestamp?: number;
}

/** generate_test_inputs.mjs#scenarios ile aynı senaryolar. */
export const SCENARIOS: { name: string; overrides: Overrides }[] = [
  { name: 'ok_compliant', overrides: {} },
  { name: 'ok_no_time_window', overrides: { timeActive: 0, timestamp: TIMESTAMP + 6 * HOUR } },
  {
    name: 'ok_at_every_limit',
    overrides: {
      netAmount: 100n * USDC,
      dailySpentBefore: 400n * USDC,
      dailyCeiling: 500n * USDC,
      timestamp: TIMESTAMP + 3 * HOUR + 46 * 60 + 39,
    },
  },
  { name: 'ok_sold_claim', overrides: { payee: world.claimBuyer } },
  { name: 'bad_per_tx', overrides: { netAmount: 100n * USDC + 1n } },
  { name: 'bad_daily_private', overrides: { dailySpentBefore: 480n * USDC } },
  { name: 'bad_mint_not_whitelisted', overrides: { mint: NATIVE_MINT } },
  { name: 'bad_payee_blocked', overrides: { payee: world.blockedWallet } },
  { name: 'bad_category', overrides: { paymentCategory: 'gambling' } },
  { name: 'bad_time_window_day', overrides: { timestamp: TIMESTAMP + 5 * DAY } },
  { name: 'bad_time_window_hour', overrides: { timestamp: TIMESTAMP + 3 * HOUR + 46 * 60 + 40 } },
  { name: 'bad_daily_ceiling', overrides: { maxDaily: 2000n * USDC, dailyCeiling: 220n * USDC } },
  { name: 'bad_zero_ceiling', overrides: { dailyCeiling: 0n } },
  {
    name: 'bad_several_rules',
    overrides: { netAmount: 150n * USDC, dailySpentBefore: 900n * USDC, timestamp: TIMESTAMP + 6 * HOUR },
  },
];

/** Senaryonun politika dokümanı, ödeme kategorisi ve release değerleri. */
export function scenario(overrides: Overrides): {
  policy: PolicyDocument;
  paymentCategory: string;
  facts: ReleaseFacts;
} {
  const o = {
    maxPerTx: 100n * USDC,
    maxDaily: 500n * USDC,
    dailyCeiling: 1000n * USDC,
    paymentCategory: 'research',
    payee: world.agentWallet,
    netAmount: 25n * USDC,
    mint: USDC_DEVNET,
    dailySpentBefore: 200n * USDC,
    timestamp: TIMESTAMP,
    ...overrides,
  };
  return {
    policy: {
      institution: world.institution.toBase58(),
      policyId: hex(world.policyId),
      version: 1,
      dailyCeiling: String(o.dailyCeiling),
      maxDaily: String(o.maxDaily),
      maxPerTx: String(o.maxPerTx),
      tokenWhitelist: [USDC_DEVNET.toBase58()],
      blockedPayees: [world.blockedWallet.toBase58()],
      allowedCategories: ['research', 'data'],
      timeWindow:
        overrides.timeActive === 0
          ? null
          : { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], startHourUtc: 9, endHourUtc: 17 },
    },
    paymentCategory: o.paymentCategory,
    facts: {
      job: world.job,
      payee: o.payee,
      netAmount: o.netAmount,
      mint: o.mint,
      dailySpentBefore: o.dailySpentBefore,
      timestamp: o.timestamp,
      stripeReceiptHash: 0n,
    },
  };
}
