// RPC taraması (backfill ve canlı takip): her program için imleçten yeni kesinleşmiş imzalar
// `getSignaturesForAddress` ile yeniden eskiye sayfalanır, sonra eskiden yeniye işlenir. İmleç işlenen her
// imzayla aynı transaction'da ilerler; süreç yarıda kesilirse kalan imzalar bir sonraki taramada işlenir.
// İmleç yokken programın bütün geçmişi taranır (backfill). Birden çok programa dokunan tx her programın
// taramasında görünür; yeniden işleme idempotenttir.
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

  async function pollProgram(name: SquareProgramName): Promise<number> {
    const cursor = await db.indexerCursor.findUnique({ where: { program: name } });
    const signatures = await newSignatures(name, cursor?.lastSignature);
    let processed = 0;
    for (const info of signatures) {
      const position = { program: name, slot: info.slot, signature: info.signature };
      if (info.err) {
        await pipeline.exclusive((tx) => writeCursor(tx, position));
        metrics.transactions.inc({ result: 'failed' });
      } else if ((await pipeline.process(info.signature, position)) === 'pending') {
        // Kesinleşmiş imza listesinde olup tx'i henüz okunamayan (RPC düğümü geride): sonraki taramada.
        log.warn('transaction_not_available', { program: name, signature: info.signature, slot: info.slot });
        break;
      }
      metrics.cursorSlot.set({ program: name }, info.slot);
      processed += 1;
    }
    return processed;
  }

  return {
    async runOnce() {
      let total = 0;
      for (const name of names) total += await pollProgram(name);
      lastSuccess = clock();
      metrics.lastPoll.set(lastSuccess / 1000);
      if (total > 0) log.info('polled', { processed: total });
      return total;
    },
    lastSuccessAt: () => lastSuccess,
  };
}
