// @squaresdk/solana-policy — kurum tarafı: adım 1 (commitment), 5 (alıcı kökü) ve 7 (ispat bağlama).
// Politika ve salt kurumun makinesinden çıkmaz; zincire yalnızca commitment, tavan ve kök gider.
import type { Connection, PublicKey } from '@solana/web3.js';
import type { BuildOptions, BuiltTx, SquareClient } from '@squaresdk/solana-sdk';
import { NotImplementedError, type PolicyDocument, type ProveResponse } from '@squaresdk/solana-types';

/** 32 baytlık gizli salt; commitment'ın tahmin edilmesini engeller. */
export type PolicySalt = Uint8Array;

/** Devrenin kabul ettiği alan elemanlarına indirgenmiş politika (kural normalizasyonu). */
export interface NormalizedPolicy {
  policyId: Uint8Array;
  version: number;
  fieldElements: readonly bigint[];
}

export function normalizePolicy(policy: PolicyDocument): NormalizedPolicy {
  throw new NotImplementedError('normalizePolicy', 'BE-10');
}

/** Salt'lı Poseidon commitment'ı (`set_policy` / `update_policy` argümanı). */
export function computePolicyCommitment(policy: PolicyDocument, salt: PolicySalt): Uint8Array {
  throw new NotImplementedError('computePolicyCommitment', 'BE-10');
}

export function generatePolicySalt(): PolicySalt {
  throw new NotImplementedError('generatePolicySalt', 'BE-10');
}

// ---------------------------------------------------------------- adım 5: onaylı alıcılar

export interface BuyerEntry {
  buyer: PublicKey;
  /** Yaprak = sha256(buyer || leafSalt). */
  leafSalt: Uint8Array;
}

export interface BuyerTree {
  root: Uint8Array;
  entries: readonly BuyerEntry[];
}

export function buildBuyerTree(entries: readonly BuyerEntry[]): BuyerTree {
  throw new NotImplementedError('buildBuyerTree', 'BE-10');
}

/** `buy_claim` için kanıt (en fazla 16 seviye). */
export function getBuyerProof(tree: BuyerTree, buyer: PublicKey): { leafSalt: Uint8Array; merkleProof: Uint8Array[] } {
  throw new NotImplementedError('getBuyerProof', 'BE-10');
}

// ---------------------------------------------------------------- adım 7: release ispatı

/** Devrenin public ve private girdileri; zincir değerleri (payee, net, mint, sayaç, saat) zincirden okunur. */
export interface ReleaseWitness {
  job: PublicKey;
  payee: PublicKey;
  netAmount: bigint;
  mint: PublicKey;
  dailySpentBefore: bigint;
  timestamp: number;
  inputs: Readonly<Record<string, string | string[]>>;
}

export function buildReleaseWitness(params: {
  connection: Connection;
  client: SquareClient;
  job: PublicKey;
  policy: PolicyDocument;
  salt: PolicySalt;
  now?: number;
}): Promise<ReleaseWitness> {
  throw new NotImplementedError('buildReleaseWitness', 'BE-10');
}

export interface Prover {
  prove(witness: ReleaseWitness): Promise<ProveResponse>;
}

/** In-process snarkjs proving (politika makineden çıkmaz). */
export function createLocalProver(artifacts: { wasm: Uint8Array; zkey: Uint8Array }): Prover {
  throw new NotImplementedError('createLocalProver', 'BE-10');
}

/** Uzak prover (`POST /v1/prove`); güven sınırı: servis politikayı görür. */
export function createRemoteProver(config: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): Prover {
  throw new NotImplementedError('createRemoteProver', 'BE-10');
}

/** `set_compliance_proof` tx'i (verifier). */
export function buildSetComplianceProofTx(
  client: SquareClient,
  params: { authority: PublicKey; institution: PublicKey; policy: PublicKey; job: PublicKey; proof: ProveResponse },
  options: BuildOptions,
): Promise<BuiltTx> {
  throw new NotImplementedError('buildSetComplianceProofTx', 'BE-10');
}

/** Job'u izler; payee, net, sayaç ya da saat değişince ispatı yeniden üretip bağlar. Durdurma fonksiyonu döner. */
export function watchJobProof(params: {
  client: SquareClient;
  prover: Prover;
  job: PublicKey;
  policy: PolicyDocument;
  salt: PolicySalt;
  submit: (tx: BuiltTx) => Promise<string>;
  onError?: (error: unknown) => void;
}): () => void {
  throw new NotImplementedError('watchJobProof', 'BE-10');
}
