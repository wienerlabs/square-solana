// Geliştirici portalı (FE-22): API anahtarı kapsamları ve x402 ücretli uç nokta formu.
import type { ApiKeyScope, X402EndpointCreate, X402Network } from '@squaresdk/solana-types';
import { ApiKeyScopeSchema, X402EndpointCreateSchema } from '@squaresdk/solana-types';
import type { Cluster } from './config';
import { isAddress } from './config';
import { formatUnits, parseUnits } from './settlement';

/** Kapsamların açıklaması; sıra API'nin `ApiKeyScope` listesidir. */
export const SCOPE_INFO: Readonly<Record<ApiKeyScope, string>> = {
  read: 'Read jobs, policies, agents, receivables, disputes and events',
  'tx:prepare': 'Prepare unsigned transactions (POST /v1/tx)',
  'deliveries:write': 'Upload job deliveries',
  'agents:write': 'Host agent cards',
  prove: 'Request release proofs from the prover',
  'disputes:write': 'Upload dispute evidence and prepare arbitrator votes',
  'x402:serve': 'Your server: read paid endpoint definitions and report settled payments',
  'fiat:pay': 'Your payment agent: pay fiat jobs with the saved card or MPP and read their attestations',
  'disputes:read': 'Read dispute evidence and the arbitration queue',
};
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ApiKeyScopeSchema.options;

// ---------------------------------------------------------------- x402 ağları ve fiyat

/** x402 v2 Solana ağları (CAIP-2), API'nin `X402Network` sırasıyla. */
export const X402_NETWORKS: readonly { id: X402Network; label: string }[] = [
  { id: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', label: 'Solana mainnet' },
  { id: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', label: 'Solana devnet' },
  { id: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', label: 'Solana testnet' },
];

/** Ağın Circle USDC mint'i (ADR 0018); `@squaresdk/solana-x402` `usdcMint` ile aynı (testli). */
export const USDC_MINTS: Readonly<Record<X402Network, string>> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
const USDC_DECIMALS = 6;

/** Uygulamanın kümesine karşılık gelen ağ; localnet'te geliştirme için devnet. */
export function defaultNetwork(cluster: Cluster): X402Network {
  if (cluster === 'mainnet-beta') return 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  if (cluster === 'testnet') return 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z';
  return 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
}

export const networkLabel = (network: X402Network) =>
  X402_NETWORKS.find((entry) => entry.id === network)?.label ?? network;

export const isUsdc = (mint: string, network: X402Network) => USDC_MINTS[network] === mint;

/** Taban birimdeki tutar: ağın USDC'siyse "0.25 USDC", değilse taban birim. */
export function formatPrice(amount: string, mint: string, network: X402Network): string {
  return isUsdc(mint, network)
    ? `${formatUnits(BigInt(amount), USDC_DECIMALS)} USDC`
    : `${BigInt(amount).toLocaleString('en-US')} base units`;
}

// ---------------------------------------------------------------- ücretli uç nokta formu

export interface EndpointDraft {
  name: string;
  path: string;
  description: string;
  /** Mint ağın USDC'siyse USDC olarak ("0.25"), değilse taban birim. */
  price: string;
  mint: string;
  network: X402Network;
  payTo: string;
  enabled: boolean;
}

export function newEndpointDraft(cluster: Cluster, payTo: string): EndpointDraft {
  const network = defaultNetwork(cluster);
  return { name: '', path: '', description: '', price: '', mint: USDC_MINTS[network], network, payTo, enabled: true };
}

export type DraftField = 'name' | 'path' | 'description' | 'price' | 'mint' | 'payTo';
export type DraftCheck =
  { ok: true; body: X402EndpointCreate } | { ok: false; errors: Partial<Record<DraftField, string>> };

/** Formu API gövdesine çevirir; alan başına İngilizce hata. */
export function checkEndpointDraft(draft: EndpointDraft): DraftCheck {
  const errors: Partial<Record<DraftField, string>> = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > 80) errors.name = 'At most 80 characters.';
  const path = draft.path.trim();
  if (!X402EndpointCreateSchema.shape.path.safeParse(path).success) {
    errors.path = 'A route path on your server that starts with "/", without spaces or a query string.';
  }
  const description = draft.description.trim();
  if (description.length > 500) errors.description = 'At most 500 characters.';
  if (!isAddress(draft.mint.trim())) errors.mint = 'Enter the token mint address.';
  if (!isAddress(draft.payTo.trim())) errors.payTo = 'Enter the Solana address that receives payments.';

  const usdc = isUsdc(draft.mint.trim(), draft.network);
  const parsed = parseUnits(draft.price.trim(), usdc ? USDC_DECIMALS : 0);
  let amount: string | null = null;
  if (!parsed.ok) errors.price = usdc ? parsed.error : 'Enter a whole number of the mint’s base units.';
  else if (parsed.value <= 0n) errors.price = 'The price must be greater than zero.';
  else if (parsed.value >= 2n ** 64n) errors.price = 'The price is too large.';
  else amount = parsed.value.toString();

  if (Object.keys(errors).length > 0 || amount === null) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      path,
      description: description || null,
      amount,
      mint: draft.mint.trim(),
      network: draft.network,
      payTo: draft.payTo.trim(),
      enabled: draft.enabled,
    },
  };
}

/** Unix saniyesi → yerel tarih ve saat; boşsa "Never". */
export const formatTime = (seconds: number | null) =>
  seconds === null ? 'Never' : new Date(seconds * 1000).toLocaleString('en-US');
