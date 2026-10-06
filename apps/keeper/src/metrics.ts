// Prometheus metrikleri: ortak servis metrikleri (`@squaresdk/solana-observability`) ve keeper'ın kararları,
// bakiyesi, kazandığı ücret ve son turu. Ayrı bir portta (`KEEPER_METRICS_PORT`, iç ağ) `GET /metrics`.
import { Counter, Gauge, createServiceMetrics, type ServiceMetrics } from '@squaresdk/solana-observability';

export interface KeeperMetrics extends ServiceMetrics {
  /** Günlüğe yazılan kararlar: `action` (finalizePayment, lapseDispute), `outcome` ve `reason`. */
  readonly actions: Counter<'action' | 'outcome' | 'reason'>;
  /** Onaylanan finalize'ların keeper ücreti toplamı (settlement mint'inin taban birimi). */
  readonly feesEarned: Counter;
  /** Keeper cüzdanının SOL bakiyesi (lamport). */
  readonly balance: Gauge;
  /** Son başarılı turun Unix zamanı (saniye). */
  readonly lastRound: Gauge;
}

export function createMetrics(params: { service: string; version: string }): KeeperMetrics {
  const base = createServiceMetrics({ service: params.service, version: params.version });
  const registers = [base.registry];
  return {
    ...base,
    actions: new Counter({
      name: 'keeper_actions_total',
      help: 'Keeper kararları, talimata, sonuca ve sebebe göre',
      labelNames: ['action', 'outcome', 'reason'],
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
  };
}
