// PDA türetme sözleşmesi. Seed'ler BC-44 sözleşmesindeki tabloyla aynıdır (docs/design/program-interface.md §5).
// Uygulama BE-08'de; bu dosya yalnızca arayüzü tanımlar.
import type { PublicKey } from '@solana/web3.js';
import type { SquareProgramIds } from './programs.js';
import type { Pda } from './types.js';

export interface SquarePda {
  // square_registry
  registryConfig(): Pda;
  agentRecord(creator: PublicKey, agentId: string): Pda;
  screeningRecord(wallet: PublicKey): Pda;
  // square_policy
  institution(ownerKey: PublicKey): Pda;
  policy(institution: PublicKey, policyId: Uint8Array): Pda;
  // square_verifier
  verifierConfig(): Pda;
  operatorState(institution: PublicKey): Pda;
  releaseProof(job: PublicKey): Pda;
  // square_escrow
  escrowConfig(): Pda;
  job(institution: PublicKey, specHash: Uint8Array): Pda;
  vault(job: PublicKey): Pda;
  bondVault(job: PublicKey): Pda;
  claimListing(job: PublicKey): Pda;
  agentReputation(agentRecord: PublicKey): Pda;
  validationRecord(job: PublicKey): Pda;
  escrowAuthority(): Pda;
}

/** Program kimliklerinden `SquarePda` üreten fabrika. */
export type CreatePda = (programIds: SquareProgramIds) => SquarePda;
