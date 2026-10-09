// PDA türetme. Seed'ler BC-44 sözleşmesindeki tabloyla aynıdır (docs/design/program-interface.md §5)
// ve sabit metin olarak yazılmaz: her programın IDL'indeki `*_SEED` sabitlerinden okunur.
import type { Idl } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { idlBytesConstant } from './idl-constants.js';
import { SQUARE_IDLS, type SquareProgramIds, type SquareProgramName } from './programs.js';
import type { Pda } from './types.js';

/** Dört programın PDA'ları; seed'ler program arayüzünün tablosundadır (program-interface §5). */
export interface SquarePda {
  /** square_registry tekil config'i. */
  registryConfig(): Pda;
  /** Agent kaydı: oluşturan ve `agent_id` (1–32 bayt). */
  agentRecord(creator: PublicKey, agentId: string): Pda;
  /** Cüzdanın screening kaydı. */
  screeningRecord(wallet: PublicKey): Pda;
  /** Kurum hesabı (sahip anahtarından). */
  institution(ownerKey: PublicKey): Pda;
  /** Kurumun politikası (`policy_id`, 32 bayt). */
  policy(institution: PublicKey, policyId: Uint8Array): Pda;
  /** square_verifier tekil config'i. */
  verifierConfig(): Pda;
  /** Kurumun günlük sayacı (`OperatorState`). */
  operatorState(institution: PublicKey): Pda;
  /** Job'a bağlanan release ispatı. */
  releaseProof(job: PublicKey): Pda;
  /** Policy'li işin kabul öncesi ön-ispatı (ADR 0028). */
  preflightProof(job: PublicKey): Pda;
  /** square_escrow tekil config'i. */
  escrowConfig(): Pda;
  /** Job: kurum ve spec hash'i (32 bayt). */
  job(institution: PublicKey, specHash: Uint8Array): Pda;
  /** Job'un kasası (token hesabı). */
  vault(job: PublicKey): Pda;
  /** Dispute bond'unun kasası. */
  bondVault(job: PublicKey): Pda;
  /** Job'un alacak listelemesi. */
  claimListing(job: PublicKey): Pda;
  /** Agent kaydının itibarı. */
  agentReputation(agentRecord: PublicKey): Pda;
  /** Job'un settlement doğrulama kaydı. */
  validationRecord(job: PublicKey): Pda;
  /** Escrow'un kasaları imzalayan yetki PDA'sı. */
  escrowAuthority(): Pda;
}

/** Program kimliklerinden `SquarePda` üreten fabrika. */
export type CreatePda = (programIds: SquareProgramIds) => SquarePda;

/** Solana bir seed'i en fazla 32 bayt kabul eder. */
const MAX_SEED_BYTES = 32;

function bytes32(value: Uint8Array, label: string): Uint8Array {
  if (value.length !== 32) throw new Error(`${label} 32 bayt olmalı, ${value.length} bayt`);
  return value;
}

/** Program kimliklerinden PDA türetici; seed'ler IDL sabitlerinden okunur. */
export const createPda: CreatePda = (programIds) => {
  const seed = (program: SquareProgramName, name: string) => idlBytesConstant(SQUARE_IDLS[program] as Idl, name);
  const SEEDS = {
    registryConfig: seed('registry', 'REGISTRY_CONFIG_SEED'),
    agent: seed('registry', 'AGENT_SEED'),
    screening: seed('registry', 'SCREENING_SEED'),
    institution: seed('policy', 'INSTITUTION_SEED'),
    policy: seed('policy', 'POLICY_SEED'),
    verifierConfig: seed('verifier', 'VERIFIER_CONFIG_SEED'),
    operatorState: seed('verifier', 'OPERATOR_STATE_SEED'),
    releaseProof: seed('verifier', 'RELEASE_PROOF_SEED'),
    preflightProof: seed('verifier', 'PREFLIGHT_PROOF_SEED'),
    escrowConfig: seed('escrow', 'CONFIG_SEED'),
    job: seed('escrow', 'JOB_SEED'),
    vault: seed('escrow', 'VAULT_SEED'),
    bond: seed('escrow', 'BOND_SEED'),
    claim: seed('escrow', 'CLAIM_SEED'),
    reputation: seed('escrow', 'REPUTATION_SEED'),
    validation: seed('escrow', 'VALIDATION_SEED'),
    escrowAuthority: seed('escrow', 'ESCROW_AUTHORITY_SEED'),
  } as const;

  const find = (program: SquareProgramName, seeds: readonly Uint8Array[]): Pda => {
    const [address, bump] = PublicKey.findProgramAddressSync([...seeds], programIds[program]);
    return [address, bump] as const;
  };

  return {
    registryConfig: () => find('registry', [SEEDS.registryConfig]),
    agentRecord: (creator, agentId) => {
      const id = new TextEncoder().encode(agentId);
      if (id.length === 0 || id.length > MAX_SEED_BYTES) {
        throw new Error(`agentId 1–${MAX_SEED_BYTES} bayt olmalı, ${id.length} bayt`);
      }
      return find('registry', [SEEDS.agent, creator.toBytes(), id]);
    },
    screeningRecord: (wallet) => find('registry', [SEEDS.screening, wallet.toBytes()]),
    institution: (ownerKey) => find('policy', [SEEDS.institution, ownerKey.toBytes()]),
    policy: (institution, policyId) =>
      find('policy', [SEEDS.policy, institution.toBytes(), bytes32(policyId, 'policyId')]),
    verifierConfig: () => find('verifier', [SEEDS.verifierConfig]),
    operatorState: (institution) => find('verifier', [SEEDS.operatorState, institution.toBytes()]),
    releaseProof: (job) => find('verifier', [SEEDS.releaseProof, job.toBytes()]),
    preflightProof: (job) => find('verifier', [SEEDS.preflightProof, job.toBytes()]),
    escrowConfig: () => find('escrow', [SEEDS.escrowConfig]),
    job: (institution, specHash) => find('escrow', [SEEDS.job, institution.toBytes(), bytes32(specHash, 'specHash')]),
    vault: (job) => find('escrow', [SEEDS.vault, job.toBytes()]),
    bondVault: (job) => find('escrow', [SEEDS.bond, job.toBytes()]),
    claimListing: (job) => find('escrow', [SEEDS.claim, job.toBytes()]),
    agentReputation: (agentRecord) => find('escrow', [SEEDS.reputation, agentRecord.toBytes()]),
    validationRecord: (job) => find('escrow', [SEEDS.validation, job.toBytes()]),
    escrowAuthority: () => find('escrow', [SEEDS.escrowAuthority]),
  };
};
