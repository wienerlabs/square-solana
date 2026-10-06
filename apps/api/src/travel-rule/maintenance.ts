// Travel Rule bakımı: saklama süresi dolan kayıtların silinmesi ve eski ana anahtarla sarılmış veri
// anahtarlarının yeniden sarılması (service.ts `maintain`). Açılışta bir kez, sonra her aralıkta koşar; bir koşu
// bitmeden sonraki başlamaz. Hata döngüyü durdurmaz, log'a ve alarm penceresine gider. Durdurma süren koşuyu bekler.
import type { Logger } from '@squaresdk/solana-observability';
import type { MaintenanceResult } from './service.js';

export function startTravelRuleMaintenance(params: {
  run: () => Promise<MaintenanceResult>;
  intervalMs: number;
  log: Logger;
  onError: () => void;
}): () => Promise<void> {
  if (!(params.intervalMs > 0)) throw new Error('intervalMs pozitif olmalı');
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, params.intervalMs);
  };
  function tick() {
    current = params
      .run()
      .then(
        (result) => {
          if (result.purged > 0 || result.rewrapped > 0) params.log.info('travel_rule_maintenance', { ...result });
        },
        (error: unknown) => {
          params.onError();
          params.log.error('travel_rule_maintenance_failed', { error });
        },
      )
      .then(schedule);
  }

  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await current;
  };
}
