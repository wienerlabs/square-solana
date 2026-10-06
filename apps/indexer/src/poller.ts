// RPC taraması (backfill ve canlı takip): her program için imleçten yeni kesinleşmiş imzalar
// `getSignaturesForAddress` ile yeniden eskiye sayfalanır, sonra eskiden yeniye işlenir. İmleç işlenen her
// imzayla aynı transaction'da ilerler; süreç yarıda kesilirse kalan imzalar bir sonraki taramada işlenir.
// İmleç yokken programın bütün geçmişi taranır (backfill). Birden çok programa dokunan tx her programın
// taramasında görünür; yeniden işleme idempotenttir.
//
// Senkron gecikmesi: tarama başında kesinleşmiş uç okunur. Bütün programlar o uca kadar eksiksiz taranırsa
// (henüz okunamayan tx'te durulmadıysa) indexer o uçla senkrondur; `indexer_sync_lag_slots` yeni uçla son
// senkron uç arasındaki farktır.
import type { PrismaClient } from '@squaresdk/solana-db';
import type { Logger } from '@squaresdk/solana-observability';
import type { SquareProgramIds, SquareProgramName } from '@squaresdk/solana-sdk';
import type { ConfirmedSignatureInfo } from '@solana/web3.js';
import type { Chain } from './chain.js';
import type { IndexerMetrics } from './metrics.js';
import type { Pipeline } from './pipeline.js';
import { writeCursor } from './store.js';

export interface Poller {
  /** Bütün programları bir kez tarar; işlenen imza sayısını döner. */
  runOnce(): Promise<number>;
  /** Son başarılı taramanın zamanı (ms); hiç olmadıysa null. */
  lastSuccessAt(): number | null;
  /** Son taramadaki senkron gecikmesi (slot); hiç tarama olmadıysa null. */
  syncLag(): number | null;
}

export function createPoller(deps: {
  db: PrismaClient;
  chain: Chain;
  pipeline: Pipeline;
  programIds: SquareProgramIds;
  pageSize: number;
  metrics: IndexerMetrics;
  log: Logger;
  clock?: () => number;
}): Poller {
  const { db, chain, pipeline, programIds, pageSize, metrics, log } = deps;
  const clock = deps.clock ?? Date.now;
  const names = Object.keys(programIds) as SquareProgramName[];
  let lastSuccess: number | null = null;
  /** Bütün programların eksiksiz tarandığı son kesinleşmiş uç; hiç olmadıysa ilk taramanın ucu. */
  let syncedSlot: number | null = null;
  let lag: number | null = null;

  async function newSignatures(name: SquareProgramName, until: string | undefined) {
    const found: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await chain.signatures(programIds[name], {
        limit: pageSize,
        ...(until ? { until } : {}),
        ...(before ? { before } : {}),
      });
      found.push(...page);
      if (page.length < pageSize) return found.reverse();
      before = page.at(-1)!.signature;
    }
  }

  /** Programın yeni imzalarını işler; `complete` false ise henüz okunamayan bir tx'te durulmuştur. */
  async function pollProgram(name: SquareProgramName): Promise<{ processed: number; complete: boolean }> {
    const cursor = await db.indexerCursor.findUnique({ where: { program: name } });
    const backfill = cursor === null;
    const signatures = await newSignatures(name, cursor?.lastSignature);
    let processed = 0;
    for (const info of signatures) {
      const position = { program: name, slot: info.slot, signature: info.signature };
      if (info.err) {
        await pipeline.exclusive((tx) => writeCursor(tx, position));
        metrics.transactions.inc({ result: 'failed' });
      } else if ((await pipeline.process(info.signature, position, backfill)) === 'pending') {
        // Kesinleşmiş imza listesinde olup tx'i henüz okunamayan (RPC düğümü geride): sonraki taramada.
        log.warn('transaction_not_available', { program: name, signature: info.signature, slot: info.slot });
        return { processed, complete: false };
      }
      metrics.cursorSlot.set({ program: name }, info.slot);
      processed += 1;
    }
    return { processed, complete: true };
  }

  return {
    async runOnce() {
      const tip = await chain.finalizedSlot();
      let total = 0;
      let complete = true;
      for (const name of names) {
        const result = await pollProgram(name);
        total += result.processed;
        complete &&= result.complete;
      }
      if (complete) syncedSlot = tip;
      syncedSlot ??= tip;
      lag = tip - syncedSlot;
      metrics.syncLag.set(lag);
      lastSuccess = clock();
      metrics.lastPoll.set(lastSuccess / 1000);
      if (total > 0) log.info('polled', { processed: total });
      return total;
    },
    lastSuccessAt: () => lastSuccess,
    syncLag: () => lag,
  };
}
