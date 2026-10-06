// TTL yenileme: `expires_at`'ına `marginSeconds`'tan az kalmış (ya da süresi geçmiş) kayıtların cüzdanları
// yeniden taranır ve yeni karar zincire yazılır; zincirdeki kayıt `screened_at + screening_ttl_secs` ile
// yenilenir. Adaylar denetim kaydından ve indexer aynasındandır (store.ts). Son `retrySeconds` içinde kararı
// yazılmış ya da denenmiş cüzdan atlanır: başarısız tarama her koşuda yeniden denenmez, sıradaki adaylar
// beklemez. Tek bir cüzdanın hatası koşuyu durdurmaz; veritabanı hatası durdurur (döngünün `onError`'u).
import type { Logger } from '@squaresdk/solana-observability';
import type { ScreenerMetrics } from './metrics.js';
import { ScreeningFailedError, type Screener } from './screener.js';
import type { DecisionStore } from './store.js';

const MS_PER_SECOND = 1000;

export interface RenewalReport {
  readonly candidates: number;
  readonly renewed: number;
  readonly failed: number;
}

export interface Renewal {
  runOnce(): Promise<RenewalReport>;
  /** Son başarılı koşunun zamanı (ms); hiç olmadıysa null. */
  lastSuccessAt(): number | null;
}

/** Pay TTL'den küçük olmalı: aksi halde yeni yazılan kayıt hemen yeniden aday olur. */
export function assertRenewalWindow(marginSeconds: number, ttlSeconds: number): void {
  if (!(marginSeconds < ttlSeconds)) {
    throw new Error(
      `SCREENER_RENEW_MARGIN_SECONDS (${marginSeconds}) zincirdeki screening_ttl_secs'ten (${ttlSeconds}) küçük olmalı`,
    );
  }
}

export function createRenewal(deps: {
  store: DecisionStore;
  screener: Screener;
  marginSeconds: number;
  retrySeconds: number;
  batch: number;
  metrics: ScreenerMetrics;
  log: Logger;
  clock?: () => number;
}): Renewal {
  const clock = deps.clock ?? Date.now;
  let lastSuccess: number | null = null;
  return {
    async runOnce() {
      const now = clock();
      const candidates = await deps.store.renewalCandidates({
        deadline: Math.floor(now / MS_PER_SECOND) + deps.marginSeconds,
        since: new Date(now - deps.retrySeconds * MS_PER_SECOND),
        limit: deps.batch,
      });
      deps.metrics.renewalCandidates.set(candidates.length);
      let renewed = 0;
      let failed = 0;
      for (const candidate of candidates) {
        try {
          await deps.screener.screen(candidate.wallet, { trigger: 'renewal', caller: null });
          renewed += 1;
        } catch (error) {
          // Karar verilemedi ya da tx yazılamadı: denetim kaydında; geri çekilip sonra yeniden denenir.
          if (!(error instanceof ScreeningFailedError)) throw error;
          failed += 1;
        }
      }
      lastSuccess = clock();
      deps.metrics.lastRenewal.set(Math.floor(lastSuccess / MS_PER_SECOND));
      if (candidates.length > 0) deps.log.info('renewal', { candidates: candidates.length, renewed, failed });
      return { candidates: candidates.length, renewed, failed };
    },
    lastSuccessAt: () => lastSuccess,
  };
}
