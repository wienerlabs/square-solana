// Aktif arbitrator seti: zincirdeki `EscrowConfig`'in `arbitrators[..arbitrator_count]`'u, eşik (M) ve set
// sürümü (BC-32, ADR 0016). SDK ile okunur ve `ttlMs` boyunca önbellekte tutulur; set değişimi
// (`update_arbitrators`) en geç bu süre sonra görülür. Kesin kural zincirdedir: oy tx'i yine simüle edilir.
import type { SquareClient } from '@squaresdk/solana-sdk';
import { HttpError } from '../http.js';

export interface ArbitratorSet {
  /** Sıra önemlidir: `approval_mask`'ın bit i'si `arbitrators[i]`'dir. */
  readonly arbitrators: readonly string[];
  readonly threshold: number;
  readonly version: number;
}

export interface Arbitrators {
  get(): Promise<ArbitratorSet>;
  /** Cüzdanın setteki sırası; üye değilse null. */
  indexOf(wallet: string): Promise<number | null>;
}

export function createArbitrators(deps: { client: SquareClient; ttlMs: number; clock?: () => number }): Arbitrators {
  const clock = deps.clock ?? Date.now;
  let cached: { set: ArbitratorSet; at: number } | null = null;
  let pending: Promise<ArbitratorSet> | null = null;

  async function load(): Promise<ArbitratorSet> {
    let config;
    try {
      config = await deps.client.escrow.fetch('escrowConfig', deps.client.pda.escrowConfig()[0]);
    } catch (error) {
      throw new HttpError(503, 'rpc_unavailable', 'escrow config okunamadı', null, null, error);
    }
    if (!config) throw new HttpError(503, 'rpc_unavailable', 'escrow config zincirde yok', null, null);
    const set: ArbitratorSet = Object.freeze({
      arbitrators: Object.freeze(
        config.arbitrators.slice(0, config.arbitratorCount).map((key: { toBase58(): string }) => key.toBase58()),
      ),
      threshold: config.threshold,
      version: config.arbitratorSetVersion,
    });
    cached = { set, at: clock() };
    return set;
  }

  const get = async (): Promise<ArbitratorSet> => {
    if (cached && clock() - cached.at < deps.ttlMs) return cached.set;
    // Eşzamanlı istekler tek okuma paylaşır.
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  };

  return {
    get,
    async indexOf(wallet) {
      const index = (await get()).arbitrators.indexOf(wallet);
      return index === -1 ? null : index;
    },
  };
}
