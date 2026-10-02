import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Thin Helius client used by the watcher. We only consume two endpoints:
 *
 *   - GET /v0/addresses/:address/transactions  (Enhanced Transactions API)
 *     Returns signature + parsed token transfer data for a wallet.
 *   - JSON-RPC getTransaction (fallback when Enhanced parsing yields no
 *     token transfer info, e.g. for Jupiter-style swap routes)
 *
 * Anything we read off the response is narrowed to the fields the watcher
 * actually consumes; new Helius schema additions stay untyped on purpose so
 * a silent schema drift can be spotted at parse time rather than runtime.
 */

export interface HeliusTokenTransfer {
  readonly fromUserAccount: string | null;
  readonly toUserAccount: string | null;
  readonly fromTokenAccount: string | null;
  readonly toTokenAccount: string | null;
  readonly tokenAmount: number | null;
  readonly mint: string;
  readonly tokenStandard?: string;
}

export interface HeliusEnhancedTransaction {
  readonly signature: string;
  readonly timestamp: number;
  readonly slot: number;
  readonly type: string;
  readonly source: string;
  readonly fee: number;
  readonly feePayer: string;
  readonly tokenTransfers?: readonly HeliusTokenTransfer[];
  readonly nativeTransfers?: ReadonlyArray<{
    readonly fromUserAccount: string;
    readonly toUserAccount: string;
    readonly amount: number;
  }>;
}

export interface FetchHeliusOptions {
  readonly limit?: number;
  /// Only pull transactions newer than this signature. Helius API uses the
  /// `until` parameter to upper-bound the range; pagination walks backwards
  /// from the most recent signature, so `until` represents "stop once you
  /// see this signature" - exactly the cursor semantics the watcher needs.
  readonly until?: string | null;
}

export class HeliusUnconfiguredError extends Error {
  constructor() {
    super(
      'HELIUS_API_KEY is not set; the unattested-payment watcher cannot pull parsed transactions.',
    );
    this.name = 'HeliusUnconfiguredError';
  }
}

function heliusBaseUrl(): string {
  // Helius routes per network through different subdomains. Mainnet uses
  // `api.helius.xyz`; devnet uses `api-devnet.helius.xyz`. Production
  // deployments always set HELIUS_NETWORK explicitly via env.
  const net = config.helius.network;
  if (net === 'mainnet' || net === 'mainnet-beta') {
    return 'https://api.helius.xyz';
  }
  return 'https://api-devnet.helius.xyz';
}

export function isHeliusConfigured(): boolean {
  return Boolean(config.helius.apiKey);
}

/**
 * Pulls the most recent N parsed transactions for `address`. Helius returns
 * up to 100 per call and orders them newest-first; the caller paginates by
 * passing the oldest signature it has seen back as `until` once the watcher
 * has caught up to a known cursor.
 */
export async function fetchEnhancedTransactions(
  address: string,
  options: FetchHeliusOptions = {},
): Promise<HeliusEnhancedTransaction[]> {
  if (!isHeliusConfigured()) throw new HeliusUnconfiguredError();
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const params = new URLSearchParams({
    'api-key': config.helius.apiKey,
    limit: String(limit),
  });
  if (options.until) {
    params.set('until', options.until);
  }
  const url = `${heliusBaseUrl()}/v0/addresses/${address}/transactions?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Helius enhanced-transactions HTTP ${res.status} for ${address}: ${body.slice(0, 240)}`,
    );
  }
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) {
    logger.warn('Helius returned non-array enhanced response', { address });
    return [];
  }
  return json as HeliusEnhancedTransaction[];
}
