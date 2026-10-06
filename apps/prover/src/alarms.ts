// Prover'ın eşik alarmları (`@squaresdk/solana-observability`): kuyruk birikmesi ve iç hatayla biten
// ispatlar. Eşikler ortamdandır (`PROVER_ALERT_*`); bildirim log'a ve verilmişse webhook'a gider.
import type { AlarmRule, EventWindow } from '@squaresdk/solana-observability';
import type { AlertThresholds } from './config.js';
import type { Limiter } from './limiter.js';

export function proverAlarmRules(params: {
  limiter: Limiter;
  failures: EventWindow;
  thresholds: AlertThresholds;
}): AlarmRule[] {
  const { limiter, failures, thresholds } = params;
  return [
    {
      name: 'prover_queue_backlog',
      description: 'Sırada bekleyen ispat isteği eşiğin üstünde: kapasite yetmiyor',
      severity: 'warning',
      read: () => limiter.stats().queued,
      above: thresholds.queueDepth,
      forSeconds: thresholds.queueSeconds,
    },
    {
      name: 'prover_failures',
      description: `Son ${thresholds.failureWindowSeconds} saniyede iç hatayla biten ispatlar eşiğin üstünde`,
      severity: 'critical',
      read: () => failures.count(),
      above: thresholds.failures,
      forSeconds: 0,
    },
  ];
}
