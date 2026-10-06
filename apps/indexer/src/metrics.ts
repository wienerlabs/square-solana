// Prometheus metrikleri: ortak servis metrikleri (`@squaresdk/solana-observability`) ve indexer'ın işleme,
// imleç, gecikme, uzlaştırma ve webhook sayaçları. Ayrı bir portta (`INDEXER_METRICS_PORT`, iç ağ) `GET /metrics`.
// Gecikme ölçümleri SLO'ların girdisidir ([docs/slo.md](../../../docs/slo.md)).
import { Counter, Gauge, Histogram, createServiceMetrics, type ServiceMetrics } from '@squaresdk/solana-observability';

/**
 * `indexer_ingest_delay_seconds` kovaları. Kesinleşme tek başına ~13 s ekler; SLO sınırı (60 s) bir kovadır.
 */
export const INGEST_DELAY_BUCKETS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 300, 600, 1800] as const;

export interface IndexerMetrics extends ServiceMetrics {
  /** İşlenen tx'ler: `indexed`, `failed` (başarısız tx), `pending` (henüz kesinleşmemiş). */
  readonly transactions: Counter<'result'>;
  readonly events: Counter<'program'>;
  readonly truncatedLogs: Counter;
  /** Sözleşme IDL'iyle çözülemeyip atlanan hesaplar. */
  readonly undecodableAccounts: Counter<'program' | 'kind'>;
  /** Program başına imlecin slot'u. */
  readonly cursorSlot: Gauge<'program'>;
  /** Son başarılı taramanın Unix zamanı (saniye). */
  readonly lastPoll: Gauge;
  /** Canlı tx'in blok zamanından ayna tablolara yazılmasına kadar geçen süre (backfill sayılmaz). */
  readonly ingestDelay: Histogram;
  /** Kesinleşmiş zincir ucunun, bütün programların eksiksiz tarandığı son uçtan farkı (slot). */
  readonly syncLag: Gauge;
  /** Son uzlaştırmanın tablo başına sapması. */
  readonly reconcileDrift: Gauge<'table'>;
  /** Son uzlaştırmada zincirde olup sözleşme IDL'iyle çözülemeyen hesaplar, tabloya göre. */
  readonly reconcileUndecodable: Gauge<'table'>;
  readonly reconcileRuns: Counter<'result'>;
  /** Webhook imzaları: `accepted`, `duplicate`, `dropped` (kuyruk dolu), `expired`, `failed`, `indexed`. */
  readonly webhookSignatures: Counter<'result'>;
  readonly webhookPending: Gauge;
  /** İşleme hataları: `poll`, `webhook`, `reconcile`. */
  readonly errors: Counter<'stage'>;
}

export function createMetrics(params: { service: string; version: string }): IndexerMetrics {
  const base = createServiceMetrics({ service: params.service, version: params.version });
  const registers = [base.registry];
  return {
    ...base,
    transactions: new Counter({
      name: 'indexer_transactions_total',
      help: 'İşlenen tx sayısı, sonuca göre',
      labelNames: ['result'],
      registers,
    }),
    events: new Counter({
      name: 'indexer_events_total',
      help: 'Çözülen program event sayısı',
      labelNames: ['program'],
      registers,
    }),
    truncatedLogs: new Counter({
      name: 'indexer_truncated_logs_total',
      help: 'Logu kırpılmış tx sayısı (ayna tablolar hesap okumasıyla yazılır)',
      registers,
    }),
    undecodableAccounts: new Counter({
      name: 'indexer_undecodable_accounts_total',
      help: 'Sözleşme IDL’iyle çözülemeyip atlanan hesaplar',
      labelNames: ['program', 'kind'],
      registers,
    }),
    cursorSlot: new Gauge({
      name: 'indexer_cursor_slot',
      help: 'Program başına işlenmiş son imzanın slot’u',
      labelNames: ['program'],
      registers,
    }),
    lastPoll: new Gauge({
      name: 'indexer_last_poll_timestamp_seconds',
      help: 'Son başarılı taramanın Unix zamanı',
      registers,
    }),
    ingestDelay: new Histogram({
      name: 'indexer_ingest_delay_seconds',
      help: 'Canlı tx’in blok zamanından veritabanına yazılmasına kadar geçen süre',
      buckets: [...INGEST_DELAY_BUCKETS],
      registers,
    }),
    syncLag: new Gauge({
      name: 'indexer_sync_lag_slots',
      help: 'Kesinleşmiş zincir ucunun eksiksiz taranmış son uçtan farkı (slot)',
      registers,
    }),
    reconcileDrift: new Gauge({
      name: 'indexer_reconcile_drift',
      help: 'Son uzlaştırmada zincirle veritabanı arasındaki sapma, tabloya göre',
      labelNames: ['table'],
      registers,
    }),
    reconcileUndecodable: new Gauge({
      name: 'indexer_reconcile_undecodable',
      help: 'Son uzlaştırmada sözleşme IDL’iyle çözülemeyen hesaplar, tabloya göre',
      labelNames: ['table'],
      registers,
    }),
    reconcileRuns: new Counter({
      name: 'indexer_reconcile_runs_total',
      help: 'Uzlaştırma koşuları, sonuca göre',
      labelNames: ['result'],
      registers,
    }),
    webhookSignatures: new Counter({
      name: 'indexer_webhook_signatures_total',
      help: 'Webhook’tan gelen imzalar, sonuca göre',
      labelNames: ['result'],
      registers,
    }),
    webhookPending: new Gauge({
      name: 'indexer_webhook_pending',
      help: 'Kesinleşmeyi bekleyen webhook imzası',
      registers,
    }),
    errors: new Counter({
      name: 'indexer_errors_total',
      help: 'İşleme hataları, aşamaya göre',
      labelNames: ['stage'],
      registers,
    }),
  };
}
