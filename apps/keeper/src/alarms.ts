// Keeper'ın eşik alarmları (`@squaresdk/solana-observability`): düşük bakiye (keeper işlem ücreti ve rent
// ödeyemez hale gelir), durma ve hatalar. Eşikler ortamdandır (`KEEPER_ALERT_*`).
import type { AlarmRule, EventWindow } from '@squaresdk/solana-observability';

export function keeperAlarmRules(params: {
  lastRoundAt: () => number | null;
  lastBalance: () => bigint | null;
  /** Servisin açıldığı zaman (ms): hiç tur olmadıysa durma süresi buradan sayılır. */
  startedAt: number;
  errors: EventWindow;
  thresholds: { minBalanceLamports: bigint; stallSeconds: number; errors: number; errorWindowSeconds: number };
  clock?: () => number;
}): AlarmRule[] {
  const { thresholds } = params;
  const clock = params.clock ?? Date.now;
  return [
    {
      name: 'keeper_low_balance',
      description: `Keeper bakiyesi ${thresholds.minBalanceLamports} lamport'un altında: işlem ücreti ve rent ödenemeyebilir`,
      severity: 'critical',
      // Eşiğin altındaki eksik miktar; bakiye okunmadıysa 0.
      read: () => {
        const balance = params.lastBalance();
        return balance === null ? 0 : Math.max(0, Number(thresholds.minBalanceLamports - balance));
      },
      above: 0,
      forSeconds: 0,
    },
    {
      name: 'keeper_stalled',
      description: `Son ${thresholds.stallSeconds} saniyede başarılı tur yok`,
      severity: 'critical',
      read: () => (clock() - (params.lastRoundAt() ?? params.startedAt)) / 1000,
      above: thresholds.stallSeconds,
      forSeconds: 0,
    },
    {
      name: 'keeper_errors',
      description: `Son ${thresholds.errorWindowSeconds} saniyede başarısız finalize ve tur hataları eşiğin üstünde`,
      severity: 'warning',
      read: () => params.errors.count(),
      above: thresholds.errors,
      forSeconds: 0,
    },
  ];
}
