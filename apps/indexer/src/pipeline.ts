// Tek bir kesinleşmiş tx'in işlenmesi: event'ler `chain_events`'e, tx'in yazılabilir Square hesapları
// zincirden okunarak ayna tablolara. Event hangi hesabın değiştiğini bildirir; değişen her hesap tx'te
// yazılabilirdir. Bu yüzden indexer event'e göre hesap seçmez, yazılabilir hesapların hepsini okur: kırpılmış
// logda (`Log truncated`) da ayna tablolar doğru kalır (event şeması §5). Başarısız tx durum değiştirmez,
// event'i yazılmaz. Sözleşme IDL'iyle çözülemeyen hesap (aynı adresteki eski dağıtımın düzeni) atlanır,
// sayılır ve log'a yazılır; çözülemeyen event ise hatadır (yayımlanmış event değişmez, event şeması §4). Veritabanı yazmaları tek bir transaction'dadır ve sırayla yapılır (`exclusive`).
import type { PrismaClient } from '@squaresdk/solana-db';
import type { Logger } from '@squaresdk/solana-observability';
import type { Chain } from './chain.js';
import { UndecodableAccountError, type Codec } from './codec.js';
import type { IndexerMetrics } from './metrics.js';
import {
  writeAccountStates,
  writeCursor,
  writeEvents,
  type AccountState,
  type CursorPosition,
  type Tx,
} from './store.js';

export type ProcessResult = 'indexed' | 'failed' | 'pending';

export interface Pipeline {
  /**
   * İmzayı işler. Tx kesinleşmemişse (`getTransaction` finalized'da bulamazsa) `pending`; hiçbir şey yazılmaz.
   * `cursor` verilirse imleç aynı transaction'da ilerler.
   */
  process(signature: string, cursor?: CursorPosition): Promise<ProcessResult>;
  /** Veritabanı yazmalarını sıraya koyar: aynı anda tek yazma transaction'ı. */
  exclusive<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

export function createPipeline(deps: {
  db: PrismaClient;
  chain: Chain;
  codec: Codec;
  metrics: IndexerMetrics;
  log: Logger;
  clock?: () => number;
}): Pipeline {
  const { db, chain, codec, metrics, log } = deps;
  const clock = deps.clock ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();

  const exclusive = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
    const run = queue.then(() => db.$transaction((tx) => work(tx)));
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    exclusive,
    async process(signature, cursor) {
      const tx = await chain.transaction(signature);
      if (!tx) {
        metrics.transactions.inc({ result: 'pending' });
        return 'pending';
      }
      if (tx.failed) {
        if (cursor) await exclusive((t) => writeCursor(t, cursor));
        metrics.transactions.inc({ result: 'failed' });
        return 'failed';
      }
      const { events, truncated } = codec.events(tx);
      if (truncated) {
        metrics.truncatedLogs.inc();
        log.warn('log_truncated', { signature, slot: tx.slot, decodedEvents: events.length });
      }
      const snapshot = await chain.accounts(tx.writableAccounts, tx.slot);
      const states = tx.writableAccounts.flatMap((key, index): AccountState[] => {
        const address = key.toBase58();
        const info = snapshot.accounts[index];
        if (!info) return [{ address, account: null }];
        try {
          const account = codec.account(address, info);
          return account ? [{ address, account }] : [];
        } catch (error) {
          if (!(error instanceof UndecodableAccountError)) throw error;
          metrics.undecodableAccounts.inc({ program: error.program, kind: error.kind });
          log.warn('account_undecodable', { signature, address, program: error.program, kind: error.kind, error });
          return [];
        }
      });
      const written = await exclusive(async (t) => {
        const count = await writeEvents(t, events);
        await writeAccountStates(t, states, snapshot.slot, new Date(clock()));
        if (cursor) await writeCursor(t, cursor);
        return count;
      });
      for (const event of events) metrics.events.inc({ program: event.program });
      metrics.transactions.inc({ result: 'indexed' });
      log.debug('indexed', {
        signature,
        slot: tx.slot,
        events: events.length,
        newEvents: written,
        accounts: states.length,
      });
      return 'indexed';
    },
  };
}
