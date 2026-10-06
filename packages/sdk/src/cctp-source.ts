// CCTP V2'nin kaynak zincir tarafı ve Circle'ın attestation servisi (BE-26). USDC bir EVM zincirinde
// `TokenMessengerV2.depositForBurn` ile Solana'ya (domain 5) yakılır; mint alıcısı kurumun Solana'daki USDC token
// hesabıdır, sahibi değil. Bu modül tx göndermez ve bir EVM kütüphanesine bağlı değildir: `cctpBurnCall` ve
// `cctpApproveCall` viem'in `writeContract`'ının ve wagmi'nin beklediği biçimde çağrı tarifi döner (adres, ABI,
// fonksiyon, argümanlar). Circle'ın servisi (`iris-api(-sandbox).circle.com`) burn'ü istenen kesinliğe ulaşınca
// imzalar; `fetchCctpAttestation` tek bir bakıştır, beklemeyi çağıran yapar (relayer, betik, arayüz).
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { PublicKey } from '@solana/web3.js';
import { CCTP_SOLANA_DOMAIN } from './cctp.js';

/** `minFinalityThreshold`: 1000 hızlı (Fast Transfer, ücretli), 2000 standart (kaynak zincirin kesinliği). */
export const CCTP_FINALITY = Object.freeze({ fast: 1000, standard: 2000 });
/** Kesinlik adı: `fast` ya da `standard`. */
export type CctpFinality = keyof typeof CCTP_FINALITY;

/** `TokenMessengerV2.depositForBurn` (CCTP V2, EVM). */
export const CCTP_TOKEN_MESSENGER_ABI = [
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [],
  },
] as const;

/** Kaynak zincirdeki USDC'nin (ERC-20) burn için gereken fonksiyonları. */
export const CCTP_ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** EVM adresi (0x'li, 20 bayt). */
export type EvmAddress = `0x${string}`;
/** 32 baytlık değer, 0x'li hex. */
export type Bytes32Hex = `0x${string}`;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BPS = 10_000n;
const ZERO_BYTES32: Bytes32Hex = `0x${'00'.repeat(32)}`;

function evmAddress(value: string, label: string): EvmAddress {
  if (!EVM_ADDRESS.test(value)) throw new Error(`${label} EVM adresi değil: ${value}`);
  return value as EvmAddress;
}

/** 32 baytlık değer `bytes32` olarak (0x'li küçük harf hex). */
export function toBytes32(bytes: Uint8Array): Bytes32Hex {
  if (bytes.length !== 32) throw new Error(`32 bayt bekleniyor, ${bytes.length} bayt`);
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/**
 * CCTP'nin mint alıcısı: sahibin settlement mint'indeki associated token hesabı. Sahip PDA olabilir (Squads vault).
 * `receive_message` bu hesaba mint eder, `fund_job` aynı hesaptan çeker.
 */
export const cctpMintRecipient = (owner: PublicKey, usdcMint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(usdcMint, owner, true, tokenProgram);

/** Servisin baz puanla verdiği ücretin tutardaki karşılığı, yukarı yuvarlanmış (`maxFee`). */
export function cctpMaxFee(amount: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0)
    throw new Error(`ücret baz puanı negatif olmayan tamsayı olmalı: ${feeBps}`);
  return (amount * BigInt(feeBps) + BPS - 1n) / BPS;
}

/** Servisin ücret tablosu (`/v2/burn/USDC/fees/{kaynak}/{hedef}`): kesinlik eşiği başına baz puan. */
export interface CctpFeeQuote {
  /** Kesinlik eşiği (1000, 2000). */
  readonly finalityThreshold: number;
  /** En düşük ücret, baz puan. */
  readonly minimumFee: number;
}

/** Circle'ın attestation servisine istek seçenekleri. */
export interface CctpServiceOptions {
  /** Circle'ın attestation servisi, ör. `https://iris-api-sandbox.circle.com` (sonda `/` olmadan). */
  readonly api: string;
  /** Burn'ün yapıldığı zincirin Circle domain'i. */
  readonly sourceDomain: number;
  /** İstekleri gönderen fetch; verilmezse global `fetch`. */
  readonly fetch?: typeof fetch;
}

const serviceUrl = (api: string, path: string) => `${api.replace(/\/+$/, '')}${path}`;

async function serviceError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 200);
  return new Error(`CCTP attestation servisi ${response.status}: ${body}`);
}

/** Kaynak domain'den Solana'ya ücret tablosu. */
export async function fetchCctpFees(options: CctpServiceOptions): Promise<CctpFeeQuote[]> {
  const response = await (options.fetch ?? fetch)(
    serviceUrl(options.api, `/v2/burn/USDC/fees/${options.sourceDomain}/${CCTP_SOLANA_DOMAIN}`),
  );
  if (!response.ok) throw await serviceError(response);
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('CCTP ücret tablosu dizi değil');
  return body.map((entry: { finalityThreshold?: unknown; minimumFee?: unknown }) => {
    if (typeof entry.finalityThreshold !== 'number' || typeof entry.minimumFee !== 'number') {
      throw new Error(`CCTP ücret satırı okunamadı: ${JSON.stringify(entry)}`);
    }
    return { finalityThreshold: entry.finalityThreshold, minimumFee: entry.minimumFee };
  });
}

/** viem / wagmi `writeContract` biçiminde çağrı tarifi. */
export interface EvmCall<Abi, Name extends string, Args extends readonly unknown[]> {
  /** Çağrılan sözleşme. */
  readonly address: EvmAddress;
  /** Sözleşmenin ABI'si. */
  readonly abi: Abi;
  /** Fonksiyon adı. */
  readonly functionName: Name;
  /** Argümanlar, ABI sırasıyla. */
  readonly args: Args;
}

/** `depositForBurn` çağrı tarifi ve seçilen `maxFee`. */
export type CctpBurnCall = EvmCall<
  typeof CCTP_TOKEN_MESSENGER_ABI,
  'depositForBurn',
  readonly [bigint, number, Bytes32Hex, EvmAddress, Bytes32Hex, bigint, number]
> & {
  /** Attester'ın alabileceği en fazla ücret; mint edilen en az `amount − maxFee`'dir. */
  readonly maxFee: bigint;
};

/**
 * `depositForBurn` çağrısı: tutar Solana'ya yakılır, mint alıcısı `mintRecipient` token hesabıdır, teslim eden
 * sınırlanmaz (`destinationCaller` sıfır). Ücret servisin tablosundan (`fees`) seçilen kesinliğin baz puanıdır;
 * tabloda o kesinlik yoksa ya da ücret tutarı yutuyorsa çağrı kurulmaz.
 */
export function cctpBurnCall(params: {
  tokenMessenger: string;
  burnToken: string;
  amount: bigint;
  finality: CctpFinality;
  mintRecipient: PublicKey;
  fees: readonly CctpFeeQuote[];
}): CctpBurnCall {
  if (params.amount <= 0n) throw new Error('tutar pozitif olmalı');
  const threshold = CCTP_FINALITY[params.finality];
  if (threshold === undefined) throw new Error(`kesinlik fast ya da standard olmalı: ${String(params.finality)}`);
  const quote = params.fees.find((entry) => entry.finalityThreshold === threshold);
  if (!quote) throw new Error(`servis ${threshold} kesinliği için ücret vermedi`);
  const maxFee = cctpMaxFee(params.amount, quote.minimumFee);
  if (maxFee >= params.amount) throw new Error(`ücret (${maxFee}) tutarı (${params.amount}) karşılamıyor`);
  return {
    address: evmAddress(params.tokenMessenger, 'TokenMessengerV2'),
    abi: CCTP_TOKEN_MESSENGER_ABI,
    functionName: 'depositForBurn',
    args: [
      params.amount,
      CCTP_SOLANA_DOMAIN,
      toBytes32(params.mintRecipient.toBytes()),
      evmAddress(params.burnToken, 'burn token'),
      ZERO_BYTES32,
      maxFee,
      threshold,
    ],
    maxFee,
  };
}

/** `approve(tokenMessenger, amount)`: burn'den önce allowance yetmiyorsa. */
export const cctpApproveCall = (params: {
  token: string;
  tokenMessenger: string;
  amount: bigint;
}): EvmCall<typeof CCTP_ERC20_ABI, 'approve', readonly [EvmAddress, bigint]> => ({
  address: evmAddress(params.token, 'USDC'),
  abi: CCTP_ERC20_ABI,
  functionName: 'approve',
  args: [evmAddress(params.tokenMessenger, 'TokenMessengerV2'), params.amount],
});

/** Servisin imzaladığı mesaj. `message` attestation'lı kopyadır (nonce ve alınan ücret dolu). */
export interface CctpAttestedMessage {
  /** `MessageV2` baytları (attestation'lı kopya). */
  readonly message: Uint8Array;
  /** Attester imzaları. */
  readonly attestation: Uint8Array;
  /** Circle'ın atadığı nonce (0x'li hex). */
  readonly eventNonce: string;
}

/** Attestation servisine bir bakışın sonucu. */
export type CctpAttestationLookup =
  /** Servis bu hash'i henüz görmedi (ya da hiç görmeyecek: yanlış domain, yanlış hash). */
  | { readonly state: 'notFound' }
  /** Burn görüldü, kesinlik bekleniyor. `delayReason` servisin gecikme sebebidir (ör. ücret yetersiz). */
  | { readonly state: 'pending'; readonly status: string; readonly delayReason: string | null }
  | { readonly state: 'complete'; readonly messages: readonly CctpAttestedMessage[] };

const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const hexBytes = (value: unknown, label: string): Uint8Array => {
  if (typeof value !== 'string' || !HEX.test(value)) throw new Error(`CCTP ${label} hex değil`);
  return new Uint8Array(Buffer.from(value.slice(2), 'hex'));
};

interface ServiceMessage {
  status?: unknown;
  message?: unknown;
  attestation?: unknown;
  eventNonce?: unknown;
  delayReason?: unknown;
}

/**
 * Burn tx'inin mesajları. Tx'teki bütün mesajlar imzalanmadıkça sonuç `pending`'dir; servisin bilmediği hash
 * `notFound` (404) döner. Servisin diğer hataları fırlatılır.
 */
export async function fetchCctpAttestation(
  options: CctpServiceOptions & { readonly transactionHash: string },
): Promise<CctpAttestationLookup> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.transactionHash)) {
    throw new Error(`EVM tx hash'i değil: ${options.transactionHash}`);
  }
  const response = await (options.fetch ?? fetch)(
    serviceUrl(options.api, `/v2/messages/${options.sourceDomain}?transactionHash=${options.transactionHash}`),
  );
  if (response.status === 404) return { state: 'notFound' };
  if (!response.ok) throw await serviceError(response);
  const messages = ((await response.json()) as { messages?: ServiceMessage[] }).messages ?? [];
  if (messages.length === 0) return { state: 'notFound' };
  const waiting = messages.find((entry) => entry.status !== 'complete');
  if (waiting) {
    const reason = waiting.delayReason;
    return {
      state: 'pending',
      status: String(waiting.status),
      delayReason: typeof reason === 'string' && reason !== '' && reason !== 'None' ? reason : null,
    };
  }
  return {
    state: 'complete',
    messages: messages.map((entry) => ({
      message: hexBytes(entry.message, 'mesajı'),
      attestation: hexBytes(entry.attestation, "attestation'ı"),
      eventNonce: String(entry.eventNonce),
    })),
  };
}
