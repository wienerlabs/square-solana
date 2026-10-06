// Prometheus metrikleri: ortak servis metrikleri (`@squaresdk/solana-observability`) ve screener'ın karar,
// kaynak, liste, yenileme ve bakiye ölçüleri. Ayrı bir portta (`SCREENER_METRICS_PORT`, iç ağ) `GET /metrics`.
import { Counter, Gauge, createServiceMetrics, type ServiceMetrics } from '@squaresdk/solana-observability';

export interface ScreenerMetrics extends ServiceMetrics {
  /** Kararlar: tetikleyici (`request`, `renewal`), sonuç (`recorded`, `sourceError`, `txFailed`), durum. */
  readonly decisions: Counter<'trigger' | 'outcome' | 'status'>;
  /** Kaynak denetimleri: `clear`, `flagged`, `error`. */
  readonly sourceChecks: Counter<'source' | 'result'>;
  /** Yüklü OFAC listesindeki SDN kaydı ve Solana adresi sayısı. */
  readonly ofacEntries: Gauge;
  readonly ofacAddresses: Gauge;
  /** Son başarılı liste indirmesinin Unix zamanı (saniye). */
  readonly ofacLoaded: Gauge;
  /** Son yenileme koşusunda bulunan aday. */
  readonly renewalCandidates: Gauge;
  /** Son başarılı yenileme koşusunun Unix zamanı (saniye). */
  readonly lastRenewal: Gauge;
  /** Screener authority'nin bakiyesi (lamport). */
  readonly authorityBalance: Gauge;
  /** Hatalar: `ofac_refresh`, `renewal`, `balance`. */
  readonly errors: Counter<'stage'>;
}

export function createMetrics(params: { service: string; version: string }): ScreenerMetrics {
  const base = createServiceMetrics({ service: params.service, version: params.version });
  const registers = [base.registry];
  return {
    ...base,
    decisions: new Counter({
      name: 'screener_decisions_total',
      help: 'Tarama kararları, tetikleyici, sonuç ve duruma göre',
      labelNames: ['trigger', 'outcome', 'status'],
      registers,
    }),
    sourceChecks: new Counter({
      name: 'screener_source_checks_total',
      help: 'Kaynak denetimleri, kaynak ve sonuca göre',
      labelNames: ['source', 'result'],
      registers,
    }),
    ofacEntries: new Gauge({ name: 'screener_ofac_entries', help: 'Yüklü SDN listesindeki kayıt sayısı', registers }),
    ofacAddresses: new Gauge({
      name: 'screener_ofac_sol_addresses',
      help: 'Yüklü SDN listesindeki Solana adresi sayısı',
      registers,
    }),
    ofacLoaded: new Gauge({
      name: 'screener_ofac_loaded_timestamp_seconds',
      help: 'Son başarılı SDN listesi indirmesinin Unix zamanı',
      registers,
    }),
    renewalCandidates: new Gauge({
      name: 'screener_renewal_candidates',
      help: 'Son yenileme koşusunda bulunan aday cüzdan sayısı',
      registers,
    }),
    lastRenewal: new Gauge({
      name: 'screener_last_renewal_timestamp_seconds',
      help: 'Son başarılı yenileme koşusunun Unix zamanı',
      registers,
    }),
    authorityBalance: new Gauge({
      name: 'screener_authority_balance_lamports',
      help: 'Screener authority hesabının bakiyesi',
      registers,
    }),
    errors: new Counter({
      name: 'screener_errors_total',
      help: 'Hatalar, aşamaya göre',
      labelNames: ['stage'],
      registers,
    }),
  };
}
