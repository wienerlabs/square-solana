import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2';
import type { PublicKey } from '@solana/web3.js';
import {
  buildBuyerTree,
  computePolicyCommitment,
  derivePolicySalts,
  generatePolicySecret,
  type BuyerTree,
  type PolicySalts,
} from '@squaresdk/solana-policy';
import type { SquarePda } from '@squaresdk/solana-sdk';
import { assertOutsideRepo } from '@squaresdk/solana-smoke/keys';
import { DAYS_OF_WEEK, type PolicyDocument } from '@squaresdk/solana-types';
import type { DemoPolicyValues } from './demo-config.js';

export interface DemoPolicy {
  name: string;
  address: PublicKey;
  policyId: Uint8Array;
  document: PolicyDocument;
  salts: PolicySalts;
  commitment: Uint8Array;
}

const enc = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const SECRET = /^[0-9a-f]{64}$/;

export function readPolicySecret(path: string): Uint8Array {
  assertOutsideRepo(path);
  const text = readFileSync(path, 'utf8').trim();
  if (!SECRET.test(text)) throw new Error(`politika sırrı 32 baytlık hex değil: ${path}`);
  return Uint8Array.from(Buffer.from(text, 'hex'));
}

export function loadOrCreatePolicySecret(path: string): { secret: Uint8Array; created: boolean } {
  assertOutsideRepo(path);
  if (existsSync(path)) return { secret: readPolicySecret(path), created: false };
  const secret = generatePolicySecret();
  writeFileSync(path, `${hex(secret)}\n`, { mode: 0o600, flag: 'wx' });
  return { secret, created: true };
}

export const demoPolicyId = (name: string): Uint8Array => sha256(enc(`square-demo/policy/${name}`));

export function buyerLeafSalt(secret: Uint8Array, buyer: PublicKey): Uint8Array {
  return sha256(Uint8Array.from([...enc('square-demo/buyer/'), ...secret, ...buyer.toBytes()]));
}

export function demoBuyerTree(secret: Uint8Array, buyers: readonly PublicKey[]): BuyerTree {
  return buildBuyerTree(buyers.map((buyer) => ({ buyer, leafSalt: buyerLeafSalt(secret, buyer) })));
}

export function demoPolicyDocument(params: {
  institutionPda: PublicKey;
  policyId: Uint8Array;
  mint: PublicKey;
  values: DemoPolicyValues;
  version: number;
}): PolicyDocument {
  const { values } = params;
  return {
    institution: params.institutionPda.toBase58(),
    policyId: hex(params.policyId),
    version: params.version,
    dailyCeiling: values.dailyCeiling.toString(),
    maxDaily: values.maxDaily.toString(),
    maxPerTx: values.maxPerTx.toString(),
    tokenWhitelist: [params.mint.toBase58()],
    blockedPayees: [],
    allowedCategories: [...values.categories],
    timeWindow: { days: [...DAYS_OF_WEEK], startHourUtc: 0, endHourUtc: 23 },
  };
}

export function demoPolicies(params: {
  secret: Uint8Array;
  institutionPda: PublicKey;
  mint: PublicKey;
  pda: SquarePda;
  policies: Readonly<Record<string, DemoPolicyValues>>;
}): DemoPolicy[] {
  return Object.entries(params.policies).map(([name, values]) => {
    const policyId = demoPolicyId(name);
    const document = demoPolicyDocument({
      institutionPda: params.institutionPda,
      policyId,
      mint: params.mint,
      values,
      version: 1,
    });
    const salts = derivePolicySalts(params.secret, policyId);
    return {
      name,
      address: params.pda.policy(params.institutionPda, policyId)[0],
      policyId,
      document,
      salts,
      commitment: computePolicyCommitment(document, salts),
    };
  });
}
