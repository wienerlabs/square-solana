// @squaresdk/solana-policy — kurum tarafı: adım 1 (commitment), 5 (alıcı kökü) ve 7 (ispat bağlama);
// BE-35 sözleşmesi (uygulama BE-10). Politika ve salt kurumun makinesinden çıkmaz; zincire yalnızca
// commitment, tavan ve kök gider.
import type { Connection, PublicKey } from '@solana/web3.js';
import type { BuildOptions, BuiltTx, SquareClient } from '@squaresdk/solana-sdk';
import type { PolicyDocument, ProveResponse } from '@squaresdk/solana-types';

/** 32 baytlık gizli salt; commitment'ın tahmin edilmesini engeller. */
export type PolicySalt = Uint8Array;

/** Devrenin kabul ettiği alan elemanlarına indirgenmiş politika (kural normalizasyonu). */
export interface NormalizedPolicy {
  policyId: Uint8Array;
  version: number;
  fieldElements: readonly bigint[];
}

export interface BuyerEntry {
  buyer: PublicKey;
  /** Yaprak = sha256(buyer || leafSalt). */
  leafSalt: Uint8Array;
}

export interface BuyerTree {
  root: Uint8Array;
  entries: readonly BuyerEntry[];
}

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

export interface Prover {
  prove(witness: ReleaseWitness): Promise<ProveResponse>;
}

/** Kurum tarafı araç seti arayüzü; uygulama BE-10'da. */
export interface SquarePolicyKit {
  // adım 1: politika commitment'ı
  normalizePolicy(policy: PolicyDocument): NormalizedPolicy;
  /** Salt'lı Poseidon commitment'ı (`set_policy` / `update_policy` argümanı). */
  computePolicyCommitment(policy: PolicyDocument, salt: PolicySalt): Uint8Array;
  generatePolicySalt(): PolicySalt;

  // adım 5: onaylı alıcılar
  buildBuyerTree(entries: readonly BuyerEntry[]): BuyerTree;
  /** `buy_claim` için kanıt (en fazla 16 seviye). */
  getBuyerProof(tree: BuyerTree, buyer: PublicKey): { leafSalt: Uint8Array; merkleProof: Uint8Array[] };

  // adım 7: release ispatı
  buildReleaseWitness(params: {
    connection: Connection;
    client: SquareClient;
    job: PublicKey;
    policy: PolicyDocument;
    salt: PolicySalt;
    now?: number;
  }): Promise<ReleaseWitness>;
  /** In-process snarkjs proving (politika makineden çıkmaz). */
  createLocalProver(artifacts: { wasm: Uint8Array; zkey: Uint8Array }): Prover;
  /** Uzak prover (`POST /v1/prove`); güven sınırı: servis politikayı görür. */
  createRemoteProver(config: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): Prover;
  /** `set_compliance_proof` tx'i (verifier). */
  buildSetComplianceProofTx(
    client: SquareClient,
    params: { authority: PublicKey; institution: PublicKey; policy: PublicKey; job: PublicKey; proof: ProveResponse },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  /** Job'u izler; payee, net, sayaç ya da saat değişince ispatı yeniden üretip bağlar. Durdurma fonksiyonu döner. */
  watchJobProof(params: {
    client: SquareClient;
    prover: Prover;
    job: PublicKey;
    policy: PolicyDocument;
    salt: PolicySalt;
    submit: (tx: BuiltTx) => Promise<string>;
    onError?: (error: unknown) => void;
  }): () => void;
}
