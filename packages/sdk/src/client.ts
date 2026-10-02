// Square client sözleşmesi: 4 program için typed client, tx builder'lar ve 8 adım akışı (uygulama BE-08).
// Adım 1 (policy commitment) ve 7 (ispat bağlama) kurum tarafıdır: @squaresdk/solana-policy.
import type { Idl, Program } from '@coral-xyz/anchor';
import type { Commitment, Connection, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import type { ProgramErrorRef } from '@squaresdk/solana-types';
import type { SquarePda } from './pda.js';
import type { SquareIdls, SquareProgramIds } from './programs.js';
import type {
  BuildOptions,
  BuiltTx,
  DecodedEvent,
  DisputeResolution,
  EscrowAccounts,
  InstructionBuilders,
  PolicyAccounts,
  RegistryAccounts,
  VerifierAccounts,
} from './types.js';

/** Tx imzalayabilen cüzdan (wallet-adapter ve Keypair sarmalayıcıları). */
export interface WalletLike {
  publicKey: PublicKey;
  signTransaction<T extends VersionedTransaction>(tx: T): Promise<T>;
}

export interface SquareClientConfig {
  connection: Connection;
  /** Ortam yapılandırmasından gelen program kimlikleri (BC-09); varsayılan yok. */
  programIds: SquareProgramIds;
  wallet?: WalletLike;
  commitment?: Commitment;
}

export interface ProgramClient<I extends Idl, A> {
  readonly program: Program<I>;
  /** IDL'deki her instruction için builder. */
  readonly instructions: InstructionBuilders<I>;
  /** Hesabı çözer; yoksa null. */
  fetch<K extends keyof A & string>(account: K, address: PublicKey): Promise<A[K] | null>;
}

/** 8 adımın SDK tarafı. PDA'ları, payee'yi ve dış hesapları (screening, ReleaseProof) kendisi çözer. */
export interface SquareFlow {
  /** Adım 2: agent kaydı. */
  registerAgent(
    params: { owner: PublicKey; agentId: string; agentCardUri: string; agentCardHash: Uint8Array; wallet: PublicKey },
    options: BuildOptions,
  ): Promise<BuiltTx & { agentRecord: PublicKey }>;
  /** Adım 3a: job açılışı; `spec` RFC 8785 ile hash'lenir. */
  createJob(
    params: {
      institution: PublicKey;
      agentRecord: PublicKey;
      policy?: PublicKey;
      spec: unknown;
      amount: bigint;
      deadline: number;
      challengePeriod: bigint;
    },
    options: BuildOptions,
  ): Promise<BuiltTx & { job: PublicKey; specHash: Uint8Array }>;
  /** Adım 3b: fonlama (iki tarafın screening kaydı okunur). */
  fundJob(
    params: { institution: PublicKey; job: PublicKey; institutionTokenAccount: PublicKey },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  /** Adım 4: kabul. */
  acceptJob(params: { agent: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  /** Adım 4: teslim. */
  submitWork(
    params: { agent: PublicKey; job: PublicKey; workHash: Uint8Array; deliveryUri: string },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  /** Adım 5: alacağı listeleme. */
  listClaim(params: { agent: PublicKey; job: PublicKey; price: bigint }, options: BuildOptions): Promise<BuiltTx>;
  /** Adım 5: alacağı satın alma (onaylı alıcı Merkle kanıtıyla). */
  buyClaim(
    params: {
      buyer: PublicKey;
      job: PublicKey;
      price: bigint;
      leafSalt: Uint8Array;
      merkleProof: readonly Uint8Array[];
      buyerTokenAccount: PublicKey;
    },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  cancelClaim(params: { seller: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  /** Adım 6 + 8: permissionless finalize (keeper). ReleaseProof yoksa `ProofRequired` ile döner. */
  finalizePayment(
    params: { keeper: PublicKey; job: PublicKey; keeperTokenAccount: PublicKey },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  raiseDispute(
    params: {
      institution: PublicKey;
      job: PublicKey;
      reasonHash: Uint8Array;
      bond: bigint;
      institutionTokenAccount: PublicKey;
    },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  resolveDispute(
    params: { arbitrator: PublicKey; job: PublicKey; resolution: DisputeResolution },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  executeResolution(params: { caller: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  cancelJob(
    params: { institution: PublicKey; job: PublicKey; institutionTokenAccount: PublicKey },
    options: BuildOptions,
  ): Promise<BuiltTx>;
}

export interface SquareClient {
  readonly programIds: SquareProgramIds;
  readonly pda: SquarePda;
  readonly registry: ProgramClient<SquareIdls['registry'], RegistryAccounts>;
  readonly policy: ProgramClient<SquareIdls['policy'], PolicyAccounts>;
  readonly verifier: ProgramClient<SquareIdls['verifier'], VerifierAccounts>;
  readonly escrow: ProgramClient<SquareIdls['escrow'], EscrowAccounts>;
  readonly flow: SquareFlow;
  /** Instruction'lardan imzasız v0 tx (compute budget ve ALT profilleriyle). */
  buildTx(instructions: readonly TransactionInstruction[], options: BuildOptions): Promise<BuiltTx>;
  /** Tx loglarından Anchor event'lerini çözer. */
  decodeEvents(logs: readonly string[], context: { signature: string; slot: number }): DecodedEvent[];
  /** Hata (simülasyon / gönderim) → (program, kod, ad); program hatası değilse null. */
  mapError(error: unknown): ProgramErrorRef | null;
}

/** `SquareClient` fabrikası; uygulama BE-08'de. */
export type CreateSquareClient = (config: SquareClientConfig) => SquareClient;
