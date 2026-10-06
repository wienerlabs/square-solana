// IDL'den türetilen tipler: instruction argümanları, hesaplar ve zincir hesap tipleri. Elle yazılmaz;
// IDL değişince (interfaces/build-idl.sh) bu tipler ve onları kullanan imzalar birlikte değişir.
import type { Idl, IdlAccounts, IdlEvents, IdlTypes, Program } from '@anchor-lang/core';
import type { PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import type { SquareIdls } from './programs.js';

/** Programın Anchor `methods` nesnesi (instruction adı → builder). */
export type Methods<I extends Idl> = Program<I>['methods'];

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

/** square_registry hesap tipleri (hesap adı → çözülmüş hesap). */
export type RegistryAccounts = IdlAccounts<SquareIdls['registry']>;
/** square_policy hesap tipleri. */
export type PolicyAccounts = IdlAccounts<SquareIdls['policy']>;
/** square_verifier hesap tipleri. */
export type VerifierAccounts = IdlAccounts<SquareIdls['verifier']>;
/** square_escrow hesap tipleri. */
export type EscrowAccounts = IdlAccounts<SquareIdls['escrow']>;

/** Agent kaydı (did:aip); sahip, cüzdan, agent card URI'si ve hash'i, durum. */
export type AgentRecordAccount = RegistryAccounts['agentRecord'];
/** Cüzdanın sanctions screening kaydı: durum, kaynak hash'i, son geçerlilik. */
export type ScreeningRecordAccount = RegistryAccounts['screeningRecord'];
/** Kurum hesabı: sahip anahtarı, ad, politika sayısı, varsa Squads multisig'i ve vault'u. */
export type InstitutionAccount = PolicyAccounts['institution'];
/** Harcama politikası: commitment, sürüm, günlük tavan, alıcı kökü, etkinlik. */
export type PolicyAccount = PolicyAccounts['policy'];
/** Kurumun günlük harcama sayacı (verifier; ADR 0012). */
export type OperatorStateAccount = VerifierAccounts['operatorState'];
/** Job'a bağlanan release ispatının kararı ve public input'ları. */
export type ReleaseProofAccount = VerifierAccounts['releaseProof'];
/** Escrow'un tekil config'i: program kimlikleri, settlement mint'i, parametreler, arbitrator'lar. */
export type EscrowConfigAccount = EscrowAccounts['escrowConfig'];
/** Job: taraflar, tutar, spec hash'i, durum, süreler, teslim ve dispute. */
export type JobAccount = EscrowAccounts['job'];
/** Agent'ın satışa çıkardığı alacak (release'in neti): fiyat, yüz değer, alıcı, durum. */
export type ClaimListingAccount = EscrowAccounts['claimListing'];
/** Agent kaydının itibarı: tamamlanan, başarısız ve uyuşmazlıklı işler, toplam kazanç. */
export type AgentReputationAccount = EscrowAccounts['agentReputation'];
/** Settlement'ta yazılan doğrulama kaydı (ödemenin ispatla ya da ispatsız yapıldığı). */
export type ValidationRecordAccount = EscrowAccounts['validationRecord'];

/** square_escrow IDL'indeki tanımlı tipler (yapılar, enum'lar). */
export type EscrowTypes = IdlTypes<SquareIdls['escrow']>;
/** Dispute kararı: agent lehine, kurum lehine ya da bölüşüm. */
export type DisputeResolution = EscrowTypes['disputeResolution'];

/** Dört programın event'leri (Anchor event decoder çıktısı). */
export type SquareEvents = IdlEvents<SquareIdls['registry']> &
  IdlEvents<SquareIdls['policy']> &
  IdlEvents<SquareIdls['verifier']> &
  IdlEvents<SquareIdls['escrow']>;
/** Dört programın event adları. */
export type SquareEventName = keyof SquareEvents & string;
/** Tx loglarından çözülen event. */
export interface DecodedEvent<N extends SquareEventName = SquareEventName> {
  /** Event adı (IDL'deki gibi). */
  name: N;
  /** Event'in alanları (Anchor değerleri). */
  data: SquareEvents[N];
  /** Event'i yayan tx'in imzası. */
  signature: string;
  /** Tx'in slot'u. */
  slot: number;
}

/** PDA ve bump. */
export type Pda = readonly [address: PublicKey, bump: number];

/** Tx oluşturma seçenekleri. */
export interface BuildOptions {
  /** Rent ve ücretleri ödeyen hesap; rol imzacısından ayrı olabilir (sponsor fee payer). */
  feePayer: PublicKey;
  /** Priority fee (mikro-lamport / CU); verilmezse eklenmez. */
  computeUnitPrice?: bigint;
  /** Compute unit sınırı; verilmezse akış tx türünün profil sınırını ekler (BC-28). */
  computeUnitLimit?: number;
  /** Tx'e eklenecek address lookup table'lar (Square ALT'ı, CCTP ALT'ı). */
  addressLookupTables?: readonly PublicKey[];
}

/** İmzasız v0 tx ve imzalaması gerekenler (wallet-adapter uyumlu). */
export interface BuiltTx {
  /** İmzasız v0 tx. */
  transaction: VersionedTransaction;
  /** İmzalaması gereken adresler (fee payer dahil). */
  signers: readonly PublicKey[];
  /** Tx'in kurulduğu blockhash. */
  blockhash: string;
  /** Blockhash'in geçerli olduğu son blok yüksekliği (onay beklemesi için). */
  lastValidBlockHeight: number;
}
