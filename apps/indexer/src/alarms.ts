// Indexer'ın eşik alarmları (`@squaresdk/solana-observability`): tarama durması, senkron gecikmesi,
// uzlaştırma sapması ve işleme hataları. Eşikler ortamdandır (`INDEXER_ALERT_*`); bildirim log'a ve verilmişse webhook'a gider.
import type { AlarmRule, EventWindow } from '@squaresdk/solana-observability';
import type { AlertThresholds } from './config.js';

export function indexerAlarmRules(params: {
  /** Son başarılı taramanın zamanı (ms); hiç olmadıysa null. */
  lastPollAt: () => number | null;
  /** Servisin açıldığı zaman (ms): hiç tarama olmadıysa durma süresi buradan sayılır. */
  startedAt: number;
  /** Son taramadaki senkron gecikmesi (slot); hiç tarama olmadıysa null. */
  syncLag: () => number | null;
  lastDrift: () => number | null;
  errors: EventWindow;
  thresholds: AlertThresholds;
  clock?: () => number;
}): AlarmRule[] {
  const { thresholds, errors } = params;
  const clock = params.clock ?? Date.now;
  return [
    {
      name: 'indexer_stalled',
      description: `Son ${thresholds.stallSeconds} saniyede başarılı tarama yok: indexer zincirin gerisinde kalıyor`,
      severity: 'critical',
      read: () => (clock() - (params.lastPollAt() ?? params.startedAt)) / 1000,
      above: thresholds.stallSeconds,
      forSeconds: 0,
    },
    {
      name: 'indexer_lagging',
      description: `Indexer kesinleşmiş zincir ucunun ${thresholds.lagSlots} slot'tan fazla gerisinde: okunamayan tx'te bekliyor`,
      severity: 'warning',
      read: () => params.syncLag() ?? 0,
      above: thresholds.lagSlots,
      forSeconds: 0,
    },
    {
      name: 'indexer_reconcile_drift',
      description: 'Son uzlaştırma zincirle veritabanı arasında sapma buldu',
      severity: 'warning',
      read: () => params.lastDrift() ?? 0,
      above: thresholds.drift,
      forSeconds: 0,
    },
    {
      name: 'indexer_errors',
      description: `Son ${thresholds.errorWindowSeconds} saniyede işleme hataları eşiğin üstünde`,
      severity: 'critical',
      read: () => errors.count(),
      above: thresholds.errors,
      forSeconds: 0,
    },
  ];
}
