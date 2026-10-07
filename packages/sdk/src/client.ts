// Square client: 4 program için typed client, tx builder'lar ve 8 adım akışı (BE-35 sözleşmesi,
// uygulama BE-08). Adım 1 (policy commitment) ve 7 (ispat bağlama) kurum tarafıdır:
// @squaresdk/solana-policy.
import { Program, type Idl, type Provider } from '@anchor-lang/core';
import type { Commitment, Connection, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import type { ProgramErrorRef } from '@squaresdk/solana-types';
import { mapProgramError } from './errors.js';
import { decodeEventLogs, decodeTransactionLogs, type TransactionEvents } from './events.js';
import { createFlow } from './flow.js';
import { createPda, type SquarePda } from './pda.js';
import { SQUARE_IDLS, type SquareIdls, type SquareProgramIds, type SquareProgramName } from './programs.js';
import { buildVersionedTx } from './tx.js';
import type { CctpReceiveContext } from './cctp.js';
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
  /** Cüzdanın adresi. */
  publicKey: PublicKey;
  /** Tx'i imzalar ve imzalı halini döner. */
  signTransaction<T extends VersionedTransaction>(tx: T): Promise<T>;
}

/** `createSquareClient` yapılandırması. */
export interface SquareClientConfig {
  /** Solana RPC bağlantısı. */
  connection: Connection;
  /** Ortam yapılandırmasından gelen program kimlikleri (BC-09); varsayılan yok. */
  programIds: SquareProgramIds;
  /** Anchor provider'ının cüzdanı; yalnızca okuma ve tx kurmada gerekmez. */
  wallet?: WalletLike;
  /** Okuma ve tx kurmanın commitment'ı; verilmezse bağlantınınki. */
  commitment?: Commitment;
}

/** Tek programın istemcisi: Anchor programı, instruction builder'ları, hesap okuma. */
export interface ProgramClient<I extends Idl, A> {
  /** Yapılandırmadaki adresle kurulmuş Anchor programı. */
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
  ): Promise<BuiltTx & { /** Açılacak agent kaydı. */ agentRecord: PublicKey }>;
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
  ): Promise<BuiltTx & { /** Açılacak job. */ job: PublicKey; /** Spec'in hash'i (32 bayt). */ specHash: Uint8Array }>;
  /**
   * Fiat rayı (BC-37, ADR 0024): kurumun Stripe ile ödeyeceği iş. Vault ve fonlama yok; iş her zaman bir
   * politikaya bağlıdır, iki tarafın screening kaydı açılışta okunur. Agent işi açıkken kabul eder.
   */
  createFiatJob(
    params: {
      institution: PublicKey;
      agentRecord: PublicKey;
      policy: PublicKey;
      spec: unknown;
      amount: bigint;
      deadline: number;
    },
    options: BuildOptions,
  ): Promise<BuiltTx & { /** Açılacak job. */ job: PublicKey; /** Spec'in hash'i (32 bayt). */ specHash: Uint8Array }>;
  /** Fiat iş (ADR 0024): açık işi ya da son tarihi geçmiş kabul edilmiş işi iptal eder (kurum); iade yok. */
  cancelFiatJob(params: { institution: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  /**
   * Fiat iş (ADR 0024), permissionless: verifier'ın `verify_mpp_payment_proof`'uyla bağlanmış uyumlu ispatı
   * tüketir, işi `Released` yapar; itibar ve validation kaydının rent'ini `payer` öder. Ödeme ve keeper ücreti yok.
   */
  finalizeFiatPayment(params: { payer: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  /**
   * Adım 3: Travel Rule commitment'ı (ADR 0015). `Open` işe bağlanır, fonlamaya kadar değiştirilebilir;
   * eşiği aşan iş onsuz fonlanmaz. Commitment `travelRule.commitment` ile hesaplanır.
   */
  commitTravelRule(
    params: { institution: PublicKey; job: PublicKey; commitment: Uint8Array },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  /** Adım 3b: fonlama (iki tarafın screening kaydı okunur). */
  fundJob(
    params: { institution: PublicKey; job: PublicKey; institutionTokenAccount: PublicKey },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  /**
   * Adım 3b, CCTP ile (BC-36): başka zincirde yakılan USDC'nin Solana'da mint edilmesi (Circle
   * `receive_message`) ve aynı tx'te `fund_job`. Mesajın mint alıcısı kurumun USDC hesabı olmalıdır; fonlama
   * job'un tutarını o hesaptan çeker. `minted` mint edilen tutardır (yakılan eksi Circle'ın ücreti). Tx'in boyutu
   * için `options.addressLookupTables`'a Square ALT'ı ve CCTP ALT'ı (`cctpLookupTableAddresses`) verilir.
   */
  receiveAndFundJob(
    params: {
      cctp: Omit<CctpReceiveContext, 'tokenProgram'>;
      message: Uint8Array;
      attestation: Uint8Array;
      institution: PublicKey;
      job: PublicKey;
    },
    options: BuildOptions,
  ): Promise<BuiltTx & { /** Mint edilecek tutar (yakılan eksi Circle'ın ücreti). */ minted: bigint }>;
  /**
   * Adım 4: kabul. Policy'li işte kurumun kabul öncesi ön-ispatı (`set_preflight_proof`, ADR 0028) bağlı olmalıdır;
   * yoksa escrow `PreflightRequired` ile reddeder.
   */
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
  /** Satılmamış alacak listelemesini kapatır (satıcı). */
  cancelClaim(params: { seller: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  /** Adım 6 + 8: permissionless finalize (keeper). ReleaseProof yoksa `ProofRequired` ile döner. */
  finalizePayment(
    params: { keeper: PublicKey; job: PublicKey; keeperTokenAccount: PublicKey },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  /** Challenge penceresinde teslime itiraz eder; bond kasaya kilitlenir (kurum). */
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
  /** Arbitrator oyu; eşik dolunca karar kesinleşir. */
  resolveDispute(
    params: { arbitrator: PublicKey; job: PublicKey; resolution: DisputeResolution },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  /** Kesinleşmiş dispute kararını uygular: kasayı ve bond'u karara göre dağıtır (izinsiz). */
  executeResolution(params: { caller: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  /**
   * Permissionless: son tarihi geçmiş dispute'u düşürür (ADR 0016). Bond kuruma döner; kurumun token hesabı
   * yoksa aynı tx'te açılır, ödeyici `options.feePayer`.
   */
  lapseDispute(params: { caller: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  /** Agent'ın ispatsız bekleme başvurusu: policy'li işte bond'suz dispute (ADR 0016). */
  escalateMissingProof(params: { agent: PublicKey; job: PublicKey }, options: BuildOptions): Promise<BuiltTx>;
  /** Admin: arbitrator seti (N ≤ 7) ve eşik (2 ≤ M ≤ N); set sürümü artar. */
  updateArbitrators(
    params: { admin: PublicKey; arbitrators: readonly PublicKey[]; threshold: number },
    options: BuildOptions,
  ): Promise<BuiltTx>;
  /** Job'u iptal eder; fonlanmışsa tutar kuruma döner (kurum). */
  cancelJob(
    params: { institution: PublicKey; job: PublicKey; institutionTokenAccount: PublicKey },
    options: BuildOptions,
  ): Promise<BuiltTx>;
}

/** Dört program için typed istemci (BE-08). */
export interface SquareClient {
  /** Yapılandırmadaki program kimlikleri. */
  readonly programIds: SquareProgramIds;
  /** PDA türetici. */
  readonly pda: SquarePda;
  /** square_registry istemcisi. */
  readonly registry: ProgramClient<SquareIdls['registry'], RegistryAccounts>;
  /** square_policy istemcisi. */
  readonly policy: ProgramClient<SquareIdls['policy'], PolicyAccounts>;
  /** square_verifier istemcisi. */
  readonly verifier: ProgramClient<SquareIdls['verifier'], VerifierAccounts>;
  /** square_escrow istemcisi. */
  readonly escrow: ProgramClient<SquareIdls['escrow'], EscrowAccounts>;
  /** 8 adımın tx builder'ları. */
  readonly flow: SquareFlow;
  /** Instruction'lardan imzasız v0 tx (compute budget ve ALT profilleriyle). */
  buildTx(instructions: readonly TransactionInstruction[], options: BuildOptions): Promise<BuiltTx>;
  /** Tx loglarından Anchor event'lerini çözer. */
  decodeEvents(logs: readonly string[], context: { signature: string; slot: number }): DecodedEvent[];
  /**
   * Tx loglarından event'leri tx içindeki konumlarıyla (program, üst düzey talimat, talimattaki sıra) çözer;
   * log kırpılmışsa bildirir (indexer, BE-14).
   */
  decodeTransactionEvents(logs: readonly string[], context: { signature: string; slot: number }): TransactionEvents;
  /** Hata (simülasyon / gönderim) → (program, kod, ad); program hatası değilse null. */
  mapError(error: unknown): ProgramErrorRef | null;
}

/** `SquareClient` fabrikası. */
export type CreateSquareClient = (config: SquareClientConfig) => SquareClient;

const PROGRAM_NAMES = Object.keys(SQUARE_IDLS) as SquareProgramName[];

/** IDL'deki adresi yapılandırmadaki program kimliğiyle değiştirip Anchor programı kurar. */
function program<I extends Idl>(idl: I, address: PublicKey, provider: Provider): Program<I> {
  return new Program<I>({ ...idl, address: address.toBase58() }, provider);
}

function programClient<I extends Idl, A>(prog: Program<I>): ProgramClient<I, A> {
  const methods = prog.methods as Record<
    string,
    (...args: unknown[]) => { accountsPartial(a: unknown): { instruction(): Promise<TransactionInstruction> } }
  >;
  const instructions = Object.fromEntries(
    Object.keys(methods).map((name) => [
      name,
      (args: readonly unknown[], accounts: unknown) =>
        methods[name]!(...args)
          .accountsPartial(accounts)
          .instruction(),
    ]),
  ) as unknown as InstructionBuilders<I>; // her IDL instruction'ı için çalışma zamanında eşlenir; imzalar IDL tiplerinden
  const accounts = prog.account as Record<string, { fetchNullable(address: PublicKey): Promise<unknown> }>;
  return {
    program: prog,
    instructions,
    async fetch(account, address) {
      const namespace = accounts[account];
      if (!namespace) throw new Error(`${prog.idl.metadata.name}: ${account} hesap tipi yok`);
      return (await namespace.fetchNullable(address)) as A[typeof account] | null;
    },
  };
}

/** `SquareClient`'ı yapılandırmadaki program kimlikleriyle kurar. */
export const createSquareClient: CreateSquareClient = (config) => {
  const commitment = config.commitment ?? config.connection.commitment;
  if (!commitment) throw new Error('commitment gerekli: config.commitment ya da connection commitment');
  const provider: Provider = { connection: config.connection };
  const programs = {
    registry: program(SQUARE_IDLS.registry, config.programIds.registry, provider),
    policy: program(SQUARE_IDLS.policy, config.programIds.policy, provider),
    verifier: program(SQUARE_IDLS.verifier, config.programIds.verifier, provider),
    escrow: program(SQUARE_IDLS.escrow, config.programIds.escrow, provider),
  };
  const pda = createPda(config.programIds);
  const buildTx = (instructions: readonly TransactionInstruction[], options: BuildOptions) =>
    buildVersionedTx(config.connection, commitment, instructions, options);
  const sources = PROGRAM_NAMES.map((name) => ({
    name,
    programId: config.programIds[name].toBase58(),
    coder: programs[name].coder,
    idl: programs[name].idl as Idl,
  }));
  return {
    programIds: config.programIds,
    pda,
    registry: programClient<SquareIdls['registry'], RegistryAccounts>(programs.registry),
    policy: programClient<SquareIdls['policy'], PolicyAccounts>(programs.policy),
    verifier: programClient<SquareIdls['verifier'], VerifierAccounts>(programs.verifier),
    escrow: programClient<SquareIdls['escrow'], EscrowAccounts>(programs.escrow),
    flow: createFlow({ connection: config.connection, programIds: config.programIds, pda, ...programs, buildTx }),
    buildTx,
    decodeEvents: (logs, context) => decodeEventLogs(sources, logs, context),
    decodeTransactionEvents: (logs, context) => decodeTransactionLogs(sources, logs, context),
    mapError: (error) => mapProgramError(sources, error),
  };
};
