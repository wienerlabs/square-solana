// Facilitator seçimi (ADR 0018). Varsayılan `self`: doğrulama ve uzlaştırma servisin içinde, resmi
// `@x402/svm` exact facilitator şemasıyla yapılır; işlem ücretini Square'in ücret ödeyen cüzdanı öder.
// `remote`: x402 facilitator HTTP API'si (`/verify`, `/settle`, `/supported`) konuşan harici bir
// facilitator ya da başka bir Square servisinin `createFacilitatorRouter` ile açtığı facilitator.
import {
  createSolanaRpc,
  devnet,
  mainnet,
  testnet,
  type MessagePartialSigner,
  type TransactionSigner,
} from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { toFacilitatorSvmSigner, type ExactSvmSchemeOptions, type FacilitatorRpcClient } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/facilitator';
import { SOLANA_DEVNET, SOLANA_MAINNET, SOLANA_TESTNET, type SolanaNetwork } from './networks.js';

export type FacilitatorMode = 'self' | 'remote';

/** ADR 0018: Square kendi facilitator'ını çalıştırır. */
export const DEFAULT_FACILITATOR_MODE: FacilitatorMode = 'self';

/** Ücret ödeyen cüzdan: işlemi ikinci imzacı olarak imzalar (`@solana/kit` `KeyPairSigner`'ı uyar). */
export type FeePayerSigner = TransactionSigner & MessagePartialSigner;

export interface FacilitatorLimits {
  readonly maxComputeUnits: number;
  readonly maxPriorityFeeMicroLamports: number;
  readonly maxRequiredSignatures: number;
}

export interface SelfFacilitatorOptions {
  readonly mode?: 'self';
  /**
   * Yalnızca SOL tutan, ödeme alıcısından (`payTo`) ayrı bir cüzdan. Resmi şema, ücret ödeyenin işlemde
   * token aktarmasını reddeder.
   */
  readonly feePayer: FeePayerSigner;
  /** Ağ başına RPC adresi; anahtarlar desteklenen ağlardır. Yerleşik (herkese açık) RPC kullanılmaz. */
  readonly rpcUrls: Partial<Record<SolanaNetwork, string>>;
  readonly limits: FacilitatorLimits;
  /** Resmi exact şemasının diğer ayarları (ör. bekleyen uzlaştırma deposu). */
  readonly scheme?: Omit<ExactSvmSchemeOptions, keyof FacilitatorLimits>;
}

export interface RemoteFacilitatorOptions {
  readonly mode: 'remote';
  /** Facilitator taban adresi (`…/verify`, `…/settle`, `…/supported`). */
  readonly url: string;
  /** `Authorization: Bearer <token>` olarak her çağrıya eklenir. */
  readonly authToken?: string;
  readonly timeoutMs?: number;
}

export type FacilitatorOptions = SelfFacilitatorOptions | RemoteFacilitatorOptions;

function rpcFor(network: SolanaNetwork, url: string): FacilitatorRpcClient {
  switch (network) {
    case SOLANA_MAINNET:
      return createSolanaRpc(mainnet(url));
    case SOLANA_DEVNET:
      return createSolanaRpc(devnet(url));
    case SOLANA_TESTNET:
      return createSolanaRpc(testnet(url));
    default:
      throw new Error(`desteklenmeyen ağ: ${String(network)}`);
  }
}

const LIMIT_FIELDS = ['maxComputeUnits', 'maxPriorityFeeMicroLamports', 'maxRequiredSignatures'] as const;

function checkedLimits(limits: FacilitatorLimits | undefined): FacilitatorLimits {
  if (!limits)
    throw new Error(
      'kendi facilitator için limits gerekli (maxComputeUnits, maxPriorityFeeMicroLamports, maxRequiredSignatures)',
    );
  for (const field of LIMIT_FIELDS) {
    const value: unknown = limits[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`facilitator sınırı limits.${field} pozitif tamsayı olmalı: ${String(value)}`);
    }
  }
  return {
    maxComputeUnits: limits.maxComputeUnits,
    maxPriorityFeeMicroLamports: limits.maxPriorityFeeMicroLamports,
    maxRequiredSignatures: limits.maxRequiredSignatures,
  };
}

/** Resmi `x402Facilitator`: exact şeması verilen ağlar için ücret ödeyen cüzdanla kaydedilir. */
export function createSelfFacilitator(options: SelfFacilitatorOptions): x402Facilitator {
  const limits = checkedLimits(options.limits);
  const rpcs: Record<string, FacilitatorRpcClient> = {};
  for (const [network, url] of Object.entries(options.rpcUrls) as [SolanaNetwork, string | undefined][]) {
    if (url) rpcs[network] = rpcFor(network, url);
  }
  const networks = Object.keys(rpcs);
  if (networks.length === 0) throw new Error('facilitator için en az bir ağın RPC adresi gerekir (rpcUrls)');
  const signer = toFacilitatorSvmSigner(options.feePayer, rpcs);
  return new x402Facilitator().register(
    networks as `${string}:${string}`[],
    new ExactSvmScheme(signer, undefined, { ...options.scheme, ...limits }),
  );
}

/** Facilitator'ı resource server'ın beklediği istemci arayüzüne uyarlar. */
export function localFacilitatorClient(facilitator: x402Facilitator): FacilitatorClient {
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
}

/** Yapılandırmadaki moda göre facilitator istemcisi; `mode` verilmezse ADR 0018'in varsayılanı (`self`). */
export function createFacilitatorClient(options: FacilitatorOptions): FacilitatorClient {
  if (options.mode === 'remote') {
    const { authToken } = options;
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
    return new HTTPFacilitatorClient({
      url: options.url,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(headers ? { createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }) } : {}),
    });
  }
  return localFacilitatorClient(createSelfFacilitator(options));
}
