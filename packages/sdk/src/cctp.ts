// CCTP V2 ile fonlama (BC-36). Başka zincirde `depositForBurn` ile yakılan USDC, Circle'ın attestation'ıyla
// Solana'da mint edilir. Mint, Circle'ın `MessageTransmitterV2` programının `receive_message`'ıyla yapılır;
// talimat `TokenMessengerMinterV2`'ye CPI yapar. Mint alıcısı mesajda yazılı token hesabıdır. Square escrow'unun
// ayrı bir talimatı yoktur: mint ile `fund_job` aynı tx'te art arda çalışır (`flow.receiveAndFundJob`).
//
// Circle programlarının IDL'i SDK'ya alınmaz; yalnızca bu talimatın verisi ve hesapları kurulur. Düzen Circle'ın
// `solana-cctp-contracts` reposundaki V2 programlarıdır (`MessageV2.sol`, `BurnMessageV2.sol`,
// `message_transmitter_v2`, `token_messenger_minter_v2`).
import { sha256 } from '@noble/hashes/sha2';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from '@solana/web3.js';

/** Circle'ın Solana domain'i. */
export const CCTP_SOLANA_DOMAIN = 5;

/**
 * `receive_message`'ın compute unit payı (BC-28'in yöntemi: ölçümlerin en yükseğinin iki katı, 10 bine yukarı).
 * Ölçüm: devnet'te Circle'ın MessageTransmitterV2'sine giden, yalnızca `receive_message` içeren 18 işlem
 * (2026-10-06); 178 061 – 194 880 CU. Square'in LiteSVM ölçümleri Circle'ın programını içermediği için
 * `tx-profile.json`'da değil, burada ([tx-budget.md](../../../docs/design/tx-budget.md) §CCTP).
 */
export const CCTP_RECEIVE_COMPUTE_UNITS = 390_000;

/** Circle'ın Solana'daki CCTP V2 programları (ağın yapılandırmasından). */
export interface CctpPrograms {
  /** `MessageTransmitterV2`: mesajı doğrular, nonce'u işaretler. */
  readonly messageTransmitter: PublicKey;
  /** `TokenMessengerMinterV2`: USDC'yi mint eder. */
  readonly tokenMessengerMinter: PublicKey;
}

/** Attestation'ı alınmış CCTP V2 mesajı. Sayılar büyük uçludur; 32 baytlık alanlar ham baytlardır. */
export interface CctpMessage {
  /** `MessageV2` sürümü. */
  readonly version: number;
  /** Kaynak zincirin Circle domain'i. */
  readonly sourceDomain: number;
  /** Hedef domain (Solana 5). */
  readonly destinationDomain: number;
  /** Circle'ın atadığı nonce; `used_nonce` PDA'sının tohumu. Yakma event'indeki kopyada sıfırdır. */
  readonly nonce: Uint8Array;
  /** Kaynak zincirdeki gönderen (TokenMessenger), 32 bayt. */
  readonly sender: Uint8Array;
  /** Hedefteki alıcı program (TokenMessengerMinter), 32 bayt. */
  readonly recipient: Uint8Array;
  /** Sıfır: herkes teslim edebilir. */
  readonly destinationCaller: Uint8Array;
  /** Burn'ün istediği kesinlik (1000 hızlı, 2000 standart). */
  readonly minFinalityThreshold: number;
  /** Attestation'ın verildiği kesinlik. */
  readonly finalityThresholdExecuted: number;
  /** `BurnMessageV2` gövdesi. */
  readonly burn: {
    /** `BurnMessageV2` sürümü. */
    readonly version: number;
    /** Kaynak zincirdeki USDC sözleşmesi, 32 bayta sola sıfırla doldurulmuş. */
    readonly burnToken: Uint8Array;
    /** Mint edilecek Solana token hesabı. */
    readonly mintRecipient: PublicKey;
    /** Yakılan tutar (taban birim). */
    readonly amount: bigint;
    /** Burn'ü gönderen kaynak cüzdan, 32 bayt. */
    readonly messageSender: Uint8Array;
    /** Attester'ın alabileceği en fazla ücret. */
    readonly maxFee: bigint;
    /** Attester'ın aldığı ücret; mint edilen `amount − feeExecuted`'dir. */
    readonly feeExecuted: bigint;
    /** Attestation'ın geçerliliğinin bittiği blok (attester yazar). */
    readonly expirationBlock: bigint;
  };
}

const HEADER_BYTES = 148;
const BURN_BODY_BYTES = 228;

const u32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
const u256 = (bytes: Uint8Array, offset: number) =>
  BigInt(`0x${Buffer.from(bytes.subarray(offset, offset + 32)).toString('hex')}`);
const b32 = (bytes: Uint8Array, offset: number) => bytes.slice(offset, offset + 32);

/** Mesajın başlığı ve yakma gövdesi (`MessageV2` + `BurnMessageV2`). */
export function decodeCctpMessage(message: Uint8Array): CctpMessage {
  if (message.length < HEADER_BYTES + BURN_BODY_BYTES) {
    throw new Error(`CCTP mesajı kısa: ${message.length} bayt, yakma gövdesi en az ${HEADER_BYTES + BURN_BODY_BYTES}`);
  }
  const body = message.subarray(HEADER_BYTES);
  return {
    version: u32(message, 0),
    sourceDomain: u32(message, 4),
    destinationDomain: u32(message, 8),
    nonce: b32(message, 12),
    sender: b32(message, 44),
    recipient: b32(message, 76),
    destinationCaller: b32(message, 108),
    minFinalityThreshold: u32(message, 140),
    finalityThresholdExecuted: u32(message, 144),
    burn: {
      version: u32(body, 0),
      burnToken: b32(body, 4),
      mintRecipient: new PublicKey(b32(body, 36)),
      amount: u256(body, 68),
      messageSender: b32(body, 100),
      maxFee: u256(body, 132),
      feeExecuted: u256(body, 164),
      expirationBlock: u256(body, 196),
    },
  };
}

/** Mint edilen tutar: yakılan eksi attester'ın ücreti. */
export const cctpMintedAmount = (message: CctpMessage): bigint => message.burn.amount - message.burn.feeExecuted;

const seed = (value: string | Uint8Array | PublicKey) =>
  typeof value === 'string'
    ? Buffer.from(value, 'utf8')
    : value instanceof PublicKey
      ? value.toBuffer()
      : Buffer.from(value);
const pda = (program: PublicKey, ...seeds: (string | Uint8Array | PublicKey)[]) =>
  PublicKey.findProgramAddressSync(seeds.map(seed), program)[0];

/** Mesajı teslim eden tx'in sabit hesapları (kaynak domain'e ve mint'e göre); ALT'a konabilir. */
export interface CctpReceiveContext {
  /** Circle'ın programları. */
  readonly programs: CctpPrograms;
  /** Solana'daki USDC (escrow'un settlement mint'i). */
  readonly usdcMint: PublicKey;
  /** Mesajın kaynak domain'i. */
  readonly sourceDomain: number;
  /** Kaynak zincirdeki USDC, 32 bayt. */
  readonly burnToken: Uint8Array;
  /** `TokenMessenger.fee_recipient` (`fetchCctpFeeRecipient`). */
  readonly feeRecipient: PublicKey;
  /** USDC mint'inin token programı. */
  readonly tokenProgram: PublicKey;
}

/** `receive_message`'ın mesaja bağlı olmayan hesapları; sırası talimatın hesap sırasıdır. */
export function cctpStaticAccounts(context: CctpReceiveContext) {
  const { messageTransmitter, tokenMessengerMinter } = context.programs;
  // Circle'ın tohumu domain'in ondalık yazımıdır (`"0"`, `"6"` …), sayının baytları değil.
  const domain = String(context.sourceDomain);
  return {
    authorityPda: pda(messageTransmitter, 'message_transmitter_authority', tokenMessengerMinter),
    messageTransmitterState: pda(messageTransmitter, 'message_transmitter'),
    messageTransmitterEventAuthority: pda(messageTransmitter, '__event_authority'),
    tokenMessenger: pda(tokenMessengerMinter, 'token_messenger'),
    remoteTokenMessenger: pda(tokenMessengerMinter, 'remote_token_messenger', domain),
    tokenMinter: pda(tokenMessengerMinter, 'token_minter'),
    localToken: pda(tokenMessengerMinter, 'local_token', context.usdcMint),
    tokenPair: pda(tokenMessengerMinter, 'token_pair', domain, context.burnToken),
    feeRecipientTokenAccount: getAssociatedTokenAddressSync(
      context.usdcMint,
      context.feeRecipient,
      true,
      context.tokenProgram,
    ),
    custody: pda(tokenMessengerMinter, 'custody', context.usdcMint),
    tokenMessengerEventAuthority: pda(tokenMessengerMinter, '__event_authority'),
  };
}

/**
 * Mesajın bağlamı: kaynak domain ve yakılan token mesajın kendisinden. Kaynağın token'ının Solana'daki USDC'ye
 * eşlendiğini Circle'ın `token_pair` hesabı söyler; eşlenmemiş token'ın mesajı zincirde reddedilir.
 */
export function cctpContextForMessage(
  message: CctpMessage,
  base: Omit<CctpReceiveContext, 'sourceDomain' | 'burnToken'>,
): CctpReceiveContext {
  return { ...base, sourceDomain: message.sourceDomain, burnToken: message.burn.burnToken };
}

/** Nonce'un kullanıldığını işaretleyen hesap (`["used_nonce", nonce]`); `receive_message` onu açar. */
export const cctpUsedNonceAddress = (programs: CctpPrograms, nonce: Uint8Array): PublicKey =>
  pda(programs.messageTransmitter, 'used_nonce', nonce);

/** Mesaj Solana'da teslim edildi mi: nonce hesabı varsa mint yapılmıştır (kim teslim ettiyse). */
export async function isCctpNonceUsed(
  connection: Connection,
  programs: CctpPrograms,
  nonce: Uint8Array,
): Promise<boolean> {
  const info = await connection.getAccountInfo(cctpUsedNonceAddress(programs, nonce), 'confirmed');
  return info !== null && info.owner.equals(programs.messageTransmitter);
}

/** Tek tx'te mint + fonlama için ALT adresleri: programlar ve sabit CCTP hesapları. */
export function cctpLookupTableAddresses(context: CctpReceiveContext): PublicKey[] {
  const accounts = cctpStaticAccounts(context);
  return [context.programs.messageTransmitter, context.programs.tokenMessengerMinter, ...Object.values(accounts)];
}

/** `TokenMessenger` hesabındaki ücret alıcısı (discriminator 8, üç pubkey, u32, u8'den sonra). */
const FEE_RECIPIENT_OFFSET = 8 + 32 * 3 + 4 + 1;

/** Circle'ın `TokenMessenger` hesabından ücret alıcısını okur. */
export async function fetchCctpFeeRecipient(connection: Connection, programs: CctpPrograms): Promise<PublicKey> {
  const address = pda(programs.tokenMessengerMinter, 'token_messenger');
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info || !info.owner.equals(programs.tokenMessengerMinter)) {
    throw new Error(`CCTP token_messenger hesabı yok: ${address.toBase58()}`);
  }
  return new PublicKey(info.data.subarray(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32));
}

/** Anchor talimat discriminator'ı: `sha256("global:receive_message")[..8]`. */
export const RECEIVE_MESSAGE_DISCRIMINATOR = sha256(new TextEncoder().encode('global:receive_message')).slice(0, 8);

const borshBytes = (bytes: Uint8Array) => {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/**
 * Circle'ın `receive_message`'ı: attestation'ı doğrular, nonce'u kullanılmış işaretler, USDC'yi mesajdaki
 * alıcı token hesabına mint eder. `caller` mesajın `destinationCaller`'ı sıfır değilse ona eşit olmalıdır.
 */
export function receiveMessageInstruction(params: {
  context: CctpReceiveContext;
  message: Uint8Array;
  attestation: Uint8Array;
  payer: PublicKey;
  caller: PublicKey;
}): TransactionInstruction {
  const { context, message } = params;
  const decoded = decodeCctpMessage(message);
  if (decoded.destinationDomain !== CCTP_SOLANA_DOMAIN) {
    throw new Error(`mesaj Solana için değil: hedef domain ${decoded.destinationDomain}`);
  }
  if (decoded.sourceDomain !== context.sourceDomain) {
    throw new Error(`mesajın kaynak domain'i ${decoded.sourceDomain}, bağlamınki ${context.sourceDomain}`);
  }
  if (!Buffer.from(decoded.burn.burnToken).equals(Buffer.from(context.burnToken))) {
    throw new Error('mesajın yakılan token’ı bağlamdaki kaynak USDC değil');
  }
  const accounts = cctpStaticAccounts(context);
  const { messageTransmitter, tokenMessengerMinter } = context.programs;
  const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return new TransactionInstruction({
    programId: messageTransmitter,
    keys: [
      meta(params.payer, true, true),
      meta(params.caller, false, true),
      meta(accounts.authorityPda, false),
      meta(accounts.messageTransmitterState, false),
      meta(cctpUsedNonceAddress(context.programs, decoded.nonce), true),
      meta(tokenMessengerMinter, false),
      meta(SystemProgram.programId, false),
      meta(accounts.messageTransmitterEventAuthority, false),
      meta(messageTransmitter, false),
      // `handle_receive_finalized_message`'ın hesapları (remaining accounts), Circle'ın sırasıyla.
      meta(accounts.tokenMessenger, false),
      meta(accounts.remoteTokenMessenger, false),
      meta(accounts.tokenMinter, true),
      meta(accounts.localToken, true),
      meta(accounts.tokenPair, false),
      meta(accounts.feeRecipientTokenAccount, true),
      meta(decoded.burn.mintRecipient, true),
      meta(accounts.custody, true),
      meta(context.tokenProgram, false),
      meta(accounts.tokenMessengerEventAuthority, false),
      meta(tokenMessengerMinter, false),
    ],
    data: Buffer.concat([
      Buffer.from(RECEIVE_MESSAGE_DISCRIMINATOR),
      borshBytes(message),
      borshBytes(params.attestation),
    ]),
  });
}
