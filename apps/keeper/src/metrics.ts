// Prometheus metrikleri: ortak servis metrikleri (`@squaresdk/solana-observability`) ve keeper'ın kararları,
// bakiyesi, kazandığı ücret, son turu ve gecikmesi. Ayrı bir portta (`KEEPER_METRICS_PORT`, iç ağ)
// `GET /metrics`. Gecikme ölçümleri SLO'ların girdisidir ([docs/slo.md](../../../docs/slo.md)).
import { Counter, Gauge, Histogram, createServiceMetrics, type ServiceMetrics } from '@squaresdk/solana-observability';

/** `keeper_finalize_delay_seconds` kovaları; SLO sınırları (600 s, 3 600 s) birer kovadır. */
export const FINALIZE_DELAY_BUCKETS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21_600, 86_400] as const;

export interface KeeperMetrics extends ServiceMetrics {
  /** Günlüğe yazılan kararlar: `outcome` (submitted, confirmed, skipped, failed) ve `reason`. */
  readonly actions: Counter<'outcome' | 'reason'>;
  /** Onaylanan finalize'ların keeper ücreti toplamı (settlement mint'inin taban birimi). */
  readonly feesEarned: Counter;
  /** Keeper cüzdanının SOL bakiyesi (lamport). */
  readonly balance: Gauge;
  /** Son başarılı turun Unix zamanı (saniye). */
  readonly lastRound: Gauge;
  /**
   * Challenge penceresinin bitişinden finalize'ın onayına geçen süre. `gate`: `none` politikasız iş, `proof`
   * politikalı iş (süreye kurumun ispatı bağlaması da girer).
   */
  readonly finalizeDelay: Histogram<'gate'>;
  /** Tur başında finalize edilebilir durumda bekleyen job sayısı (journal.ts `backlog`). */
  readonly dueJobs: Gauge;
  /** Bunların en eskisinin finalize edilebilir olduğundan bu yana geçen süre (saniye); yoksa 0. */
  readonly oldestDue: Gauge;
}

export function createMetrics(params: { service: string; version: string }): KeeperMetrics {
  const base = createServiceMetrics({ service: params.service, version: params.version });
  const registers = [base.registry];
  return {
    ...base,
    actions: new Counter({
      name: 'keeper_actions_total',
      help: 'Keeper kararları, sonuca ve sebebe göre',
      labelNames: ['outcome', 'reason'],
      registers,
    }),
    feesEarned: new Counter({
      name: 'keeper_fees_earned_total',
      help: 'Onaylanan finalize’ların keeper ücreti (settlement mint’inin taban birimi)',
      registers,
    }),
    balance: new Gauge({ name: 'keeper_balance_lamports', help: 'Keeper cüzdanının SOL bakiyesi', registers }),
    lastRound: new Gauge({
      name: 'keeper_last_round_timestamp_seconds',
      help: 'Son başarılı turun Unix zamanı',
      registers,
    }),
    finalizeDelay: new Histogram({
      name: 'keeper_finalize_delay_seconds',
      help: 'Challenge penceresinin bitişinden finalize’ın onayına geçen süre',
      labelNames: ['gate'],
      buckets: [...FINALIZE_DELAY_BUCKETS],
      registers,
    }),
    dueJobs: new Gauge({
      name: 'keeper_due_jobs',
      help: 'Tur başında finalize edilebilir durumda bekleyen job sayısı',
      registers,
    }),
    oldestDue: new Gauge({
      name: 'keeper_oldest_due_seconds',
      help: 'Finalize edilebilir en eski job’un bekleme süresi',
      registers,
    }),
  };
}
