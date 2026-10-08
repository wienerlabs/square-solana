import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
import type { PolicyDocument } from '@squaresdk/solana-types';
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

export function policySecretLocation(path: string): string {
  const directory = dirname(resolve(path));
  let realDirectory: string;
  try {
    realDirectory = realpathSync(directory);
  } catch (error) {
    throw new Error(`politika sırrının dizini yok: ${directory}`, { cause: error });
  }
  const location = join(realDirectory, basename(path));
  assertOutsideRepo(location);
  return location;
}

export function readPolicySecret(path: string): Uint8Array {
  const location = policySecretLocation(path);
  const text = readFileSync(location, 'utf8').trim();
  if (!SECRET.test(text)) throw new Error(`politika sırrı 32 baytlık hex değil: ${path}`);
  return Uint8Array.from(Buffer.from(text, 'hex'));
}

export function policySecretExists(path: string): boolean {
  return existsSync(policySecretLocation(path));
}

export function loadOrCreatePolicySecret(
  path: string,
  options: { allowCreate: boolean },
): { secret: Uint8Array; created: boolean } {
  const location = policySecretLocation(path);
  if (existsSync(location)) return { secret: readPolicySecret(path), created: false };
  if (!options.allowCreate) {
    throw new Error(
      `politika sırrı yok: ${path}. Zincirde bu kurumun demo politikaları var; yol yanlış olabilir. ` +
        'Yeni sırla politikaları güncellemek için seed --rotate-policy-secret ile koşulur',
    );
  }
  const secret = generatePolicySecret();
  writeFileSync(location, `${hex(secret)}\n`, { mode: 0o600, flag: 'wx' });
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
  /** Seed'in alıcısı: `blockedPayees`'teki `buyer` rolü bu adrese çözülür. */
  buyer: PublicKey;
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
    blockedPayees: values.blockedPayees.map((payee) => (payee === 'buyer' ? params.buyer : payee).toBase58()),
    allowedCategories: [...values.categories],
    timeWindow: values.timeWindow === null ? null : { ...values.timeWindow, days: [...values.timeWindow.days] },
  };
}

export function demoPolicies(params: {
  secret: Uint8Array;
  institutionPda: PublicKey;
  mint: PublicKey;
  buyer: PublicKey;
  pda: SquarePda;
  policies: Readonly<Record<string, DemoPolicyValues>>;
}): DemoPolicy[] {
  return Object.entries(params.policies).map(([name, values]) => {
    const policyId = demoPolicyId(name);
    const document = demoPolicyDocument({
      institutionPda: params.institutionPda,
      policyId,
      mint: params.mint,
      buyer: params.buyer,
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
