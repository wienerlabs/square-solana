// Adım 1: politika normalizasyonu ve salt'lı Poseidon commitment'ı (release-circuit.md §4–§5).
//   value = [max_daily, max_per_tx, operator_id, policy_id, H(kategoriler), H(engelliler), H(whitelist), pencere]
//   leaf[i] = Poseidon(i, salt[i], value[i]);  commitment = Poseidon(leaf[0..7])
import { sha256 } from '@noble/hashes/sha2';
import { PublicKey } from '@solana/web3.js';
import {
  DAYS_OF_WEEK,
  POLICY_CIRCUIT_LIMITS,
  PolicyDocumentSchema,
  type PolicyDocument,
} from '@squaresdk/solana-types';
import {
  addressField,
  BN254_R,
  bytes32Field,
  bytes32ToField,
  categoryField,
  fieldToBytes32,
  poseidon,
} from './fields.js';

/** 8 salt alan elemanı, commitment yapraklarının sırasıyla. */
export type PolicySalts = readonly bigint[];

/** Devrenin kabul ettiği alan elemanlarına indirgenmiş politika. */
export interface NormalizedPolicy {
  maxDaily: bigint;
  maxPerTx: bigint;
  dailyCeiling: bigint;
  operatorIdField: bigint;
  policyIdField: bigint;
  /** Yuva sayısına 0 ile doldurulmuş listeler. */
  allowedCategories: readonly bigint[];
  blockedAddresses: readonly bigint[];
  tokenWhitelist: readonly bigint[];
  timeActive: 0 | 1;
  /** Pazartesi = 0. bit. */
  timeDaysBitmask: number;
  timeStartHourUtc: number;
  timeEndHourUtc: number;
}

const pad = (values: readonly bigint[], slots: number) => [...values, ...Array<bigint>(slots - values.length).fill(0n)];
const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));

export function normalizePolicy(input: PolicyDocument): NormalizedPolicy {
  const policy = PolicyDocumentSchema.parse(input);
  const window = policy.timeWindow;
  return {
    maxDaily: BigInt(policy.maxDaily),
    maxPerTx: BigInt(policy.maxPerTx),
    dailyCeiling: BigInt(policy.dailyCeiling),
    operatorIdField: addressField(new PublicKey(policy.institution)),
    policyIdField: bytes32Field(hexToBytes(policy.policyId)),
    allowedCategories: pad(policy.allowedCategories.map(categoryField), POLICY_CIRCUIT_LIMITS.allowedCategories),
    blockedAddresses: pad(
      policy.blockedPayees.map((a) => addressField(new PublicKey(a))),
      POLICY_CIRCUIT_LIMITS.blockedPayees,
    ),
    tokenWhitelist: pad(
      policy.tokenWhitelist.map((a) => addressField(new PublicKey(a))),
      POLICY_CIRCUIT_LIMITS.tokenWhitelist,
    ),
    timeActive: window ? 1 : 0,
    timeDaysBitmask: window ? window.days.reduce((mask, day) => mask | (1 << DAYS_OF_WEEK.indexOf(day)), 0) : 0,
    timeStartHourUtc: window?.startHourUtc ?? 0,
    timeEndHourUtc: window?.endHourUtc ?? 0,
  };
}

function assertSalts(salts: PolicySalts): void {
  if (salts.length !== 8) throw new Error(`8 salt bekleniyor, ${salts.length}`);
  if (salts.some((s) => s < 0n || s >= BN254_R)) throw new Error('salt alan elemanı değil');
}

/** Commitment'ın sekiz değeri (§5). */
function commitmentValues(n: NormalizedPolicy): bigint[] {
  return [
    n.maxDaily,
    n.maxPerTx,
    n.operatorIdField,
    n.policyIdField,
    poseidon(n.allowedCategories),
    poseidon(n.blockedAddresses),
    poseidon(n.tokenWhitelist),
    n.timeActive === 0
      ? 0n
      : poseidon([1n, BigInt(n.timeDaysBitmask), BigInt(n.timeStartHourUtc), BigInt(n.timeEndHourUtc)]),
  ];
}

/** Salt'lı Poseidon commitment'ı, alan elemanı olarak. */
export function policyCommitmentField(policy: PolicyDocument, salts: PolicySalts): bigint {
  assertSalts(salts);
  const leaves = commitmentValues(normalizePolicy(policy)).map((value, i) => poseidon([BigInt(i), salts[i]!, value]));
  return poseidon(leaves);
}

/** `set_policy` / `update_policy`'nin `commitment` argümanı: commitment'ın 32 bayt big-endian hâli. */
export const computePolicyCommitment = (policy: PolicyDocument, salts: PolicySalts): Uint8Array =>
  fieldToBytes32(policyCommitmentField(policy, salts));

/** Zincirdeki 32 baytlık commitment'ı alan elemanına çevirir. */
export const commitmentFromBytes = (bytes: Uint8Array): bigint => bytes32ToField(bytes);

const SALT_DOMAIN = new TextEncoder().encode('square/policy-salt/v1');

/** Kurumun 32 baytlık gizli anahtarı; salt'ların tek kaynağı. Makineden çıkmaz. */
export function generatePolicySecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Politika başına 8 salt: `salt[i] = sha256(alan ‖ secret ‖ policyId ‖ i) mod r`. Aynı sır farklı
 * politikalara farklı salt'lar verir; sırrı bilmeyen commitment'ı tahmin edemez (§5).
 */
export function derivePolicySalts(secret: Uint8Array, policyId: Uint8Array): PolicySalts {
  if (secret.length !== 32) throw new Error('politika sırrı 32 bayt olmalı');
  if (policyId.length !== 32) throw new Error('policyId 32 bayt olmalı');
  return Array.from({ length: 8 }, (_, i) => {
    const digest = sha256(Uint8Array.from([...SALT_DOMAIN, ...secret, ...policyId, i]));
    return bytes32ToField(digest) % BN254_R;
  });
}
