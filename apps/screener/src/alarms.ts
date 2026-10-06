// Screener'ın eşik alarmları (`@squaresdk/solana-observability`) ve onları besleyen periyodik işler: OFAC
// listesinin yenilenmesi ve authority bakiyesinin okunması. Eşikler ortamdandır (`SCREENER_ALERT_*`);
// bildirim log'a ve verilmişse webhook'a gider.
import type { AlarmRule, EventWindow, Logger } from '@squaresdk/solana-observability';
import type { ScreeningChain } from './chain.js';
import type { ScreenerMetrics } from './metrics.js';
import type { OfacSource } from './sources/ofac.js';

const MS_PER_SECOND = 1000;

export interface AlertThresholds {
  readonly errors: number;
  readonly errorWindowSeconds: number;
  readonly minBalanceLamports: number;
}

export function screenerAlarmRules(params: {
  errors: EventWindow;
  /** Son okunan bakiye; hiç okunamadıysa null. */
  balance: () => number | null;
  ofac: Pick<OfacSource, 'ageSeconds'>;
  /** OFAC listesinin en büyük yaşı (`SCREENER_OFAC_MAX_AGE_SECONDS`). */
  ofacMaxAgeSeconds: number;
  /** Servisin açıldığı zaman (ms): liste hiç indirilmediyse yaş buradan sayılır. */
  startedAt: number;
  thresholds: AlertThresholds;
  clock?: () => number;
}): AlarmRule[] {
  const { thresholds } = params;
  const clock = params.clock ?? Date.now;
  return [
    {
      name: 'screener_errors',
      description: `Son ${thresholds.errorWindowSeconds} saniyede kaynak ve tx hataları eşiğin üstünde`,
      severity: 'critical',
      read: () => params.errors.count(),
      above: thresholds.errors,
      forSeconds: 0,
    },
    {
      name: 'screener_ofac_stale',
      description: `OFAC SDN listesi ${params.ofacMaxAgeSeconds} saniyedir yenilenemedi: tarama yapılamıyor`,
      severity: 'critical',
      read: () => params.ofac.ageSeconds() ?? (clock() - params.startedAt) / MS_PER_SECOND,
      above: params.ofacMaxAgeSeconds,
      forSeconds: 0,
    },
    {
      name: 'screener_low_balance',
      description: `Screener authority bakiyesi ${thresholds.minBalanceLamports} lamport'un altında`,
      severity: 'warning',
      // Eksik miktar; bakiye okunamadıysa bu turda değerlendirilmez.
      read: () => {
        const balance = params.balance();
        if (balance === null) throw new Error('bakiye henüz okunmadı');
        return thresholds.minBalanceLamports - balance;
      },
      above: 0,
      forSeconds: 0,
    },
  ];
}

/** OFAC listesini indirir ve metrikleri günceller; hata çağırana gider (döngünün `onError`'u). */
export async function refreshOfacList(params: {
  ofac: Pick<OfacSource, 'refresh'>;
  metrics: ScreenerMetrics;
  log: Logger;
  clock?: () => number;
}): Promise<void> {
  const list = await params.ofac.refresh();
  params.metrics.ofacEntries.set(list.entries);
  params.metrics.ofacAddresses.set(list.addresses.size);
  params.metrics.ofacLoaded.set(Math.floor((params.clock ?? Date.now)() / MS_PER_SECOND));
  if (list.invalid.length > 0) {
    params.log.warn('ofac_invalid_addresses', { count: list.invalid.length, sample: list.invalid.slice(0, 5) });
  }
  params.log.info('ofac_loaded', {
    publishDate: list.publishDate,
    sha256: list.sha256,
    entries: list.entries,
    solAddresses: list.addresses.size,
  });
}

/** Authority bakiyesini okuyan iş; son değer alarm kuralına gider. */
export function createBalanceWatch(chain: Pick<ScreeningChain, 'balance'>, metrics: ScreenerMetrics) {
  let last: number | null = null;
  return {
    async refresh(): Promise<number> {
      last = await chain.balance();
      metrics.authorityBalance.set(last);
      return last;
    },
    value: () => last,
  };
}
