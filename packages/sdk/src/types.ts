// IDL'den türetilen tipler: instruction argümanları, hesaplar ve zincir hesap tipleri. Elle yazılmaz;
// IDL değişince (interfaces/build-idl.sh) bu tipler ve onları kullanan imzalar birlikte değişir.
import type { Idl, IdlAccounts, IdlEvents, IdlTypes, Program } from '@anchor-lang/core';
import type { PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import type { SquareIdls } from './programs.js';

type Methods<I extends Idl> = Program<I>['methods'];

/** Instruction argümanları (IDL sırasıyla demet). */
export type IxArgs<I extends Idl, N extends keyof Methods<I>> = Parameters<Methods<I>[N]>;

/** Instruction hesapları; çözülebilen PDA'lar ve sabit adresler opsiyoneldir. */
export type IxAccounts<I extends Idl, N extends keyof Methods<I>> = Parameters<
  ReturnType<Methods<I>[N]>['accountsPartial']
>[0];

/** Bir programın tüm instruction'ları için builder imzaları (IDL'den eşlenir). */
export type InstructionBuilders<I extends Idl> = {
  readonly [N in keyof Methods<I>]: (args: IxArgs<I, N>, accounts: IxAccounts<I, N>) => Promise<TransactionInstruction>;
};

export type RegistryAccounts = IdlAccounts<SquareIdls['registry']>;
export type PolicyAccounts = IdlAccounts<SquareIdls['policy']>;
export type VerifierAccounts = IdlAccounts<SquareIdls['verifier']>;
export type EscrowAccounts = IdlAccounts<SquareIdls['escrow']>;

export type AgentRecordAccount = RegistryAccounts['agentRecord'];
export type ScreeningRecordAccount = RegistryAccounts['screeningRecord'];
export type InstitutionAccount = PolicyAccounts['institution'];
export type PolicyAccount = PolicyAccounts['policy'];
export type OperatorStateAccount = VerifierAccounts['operatorState'];
export type ReleaseProofAccount = VerifierAccounts['releaseProof'];
export type EscrowConfigAccount = EscrowAccounts['escrowConfig'];
export type JobAccount = EscrowAccounts['job'];
export type ClaimListingAccount = EscrowAccounts['claimListing'];
export type AgentReputationAccount = EscrowAccounts['agentReputation'];
export type ValidationRecordAccount = EscrowAccounts['validationRecord'];

export type EscrowTypes = IdlTypes<SquareIdls['escrow']>;
export type DisputeResolution = EscrowTypes['disputeResolution'];

/** Dört programın event'leri (Anchor event decoder çıktısı). */
export type SquareEvents = IdlEvents<SquareIdls['registry']> &
  IdlEvents<SquareIdls['policy']> &
  IdlEvents<SquareIdls['verifier']> &
  IdlEvents<SquareIdls['escrow']>;
export type SquareEventName = keyof SquareEvents & string;
export interface DecodedEvent<N extends SquareEventName = SquareEventName> {
  name: N;
  data: SquareEvents[N];
  signature: string;
  slot: number;
}

/** PDA ve bump. */
export type Pda = readonly [address: PublicKey, bump: number];

/** Tx oluşturma seçenekleri. */
export interface BuildOptions {
  /** Rent ve ücretleri ödeyen hesap; rol imzacısından ayrı olabilir (sponsor fee payer). */
  feePayer: PublicKey;
  computeUnitPrice?: bigint;
  computeUnitLimit?: number;
  addressLookupTables?: readonly PublicKey[];
}

/** İmzasız v0 tx ve imzalaması gerekenler (wallet-adapter uyumlu). */
export interface BuiltTx {
  transaction: VersionedTransaction;
  signers: readonly PublicKey[];
  blockhash: string;
  lastValidBlockHeight: number;
}
