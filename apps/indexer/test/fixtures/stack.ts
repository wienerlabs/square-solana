// Test fixture: indexer'ın parçalarını üretimdeki gibi kurar (index.ts'in bağlaması); zincir yerel fixture
// RPC sunucusudur, veritabanı izole Postgres konteyneri.
import { SQUARE_IDLS, createSquareClient, type SquareProgramName } from '@squaresdk/solana-sdk';
import type { PrismaClient } from '@squaresdk/solana-db';
import { createLogger } from '@squaresdk/solana-observability';
import { createChain } from '../../src/chain.js';
import { createCodec } from '../../src/codec.js';
import { createMetrics } from '../../src/metrics.js';
import { createPipeline } from '../../src/pipeline.js';
import { createPoller } from '../../src/poller.js';
import { loadProgramIds } from '../../src/programs.js';
import { createReconciler } from '../../src/reconcile.js';
import { createWebhookQueue } from '../../src/webhook.js';
import { PROGRAM_IDS } from './world.js';

export async function seedPrograms(db: PrismaClient): Promise<void> {
  await db.program.createMany({
    data: (Object.keys(PROGRAM_IDS) as SquareProgramName[]).map((name) => ({
      name,
      programId: PROGRAM_IDS[name].toBase58(),
      idlVersion: SQUARE_IDLS[name].metadata.version,
    })),
  });
}

export async function createStack(
  db: PrismaClient,
  rpcUrls: readonly string[],
  options: { pageSize?: number; maxPending?: number; pendingTtlSeconds?: number; clock?: () => number } = {},
) {
  const programIds = await loadProgramIds(db);
  const chain = createChain({ urls: rpcUrls, timeoutMs: 5_000, cooldownMs: 60_000 });
  const client = createSquareClient({ connection: chain.connection, programIds, commitment: 'finalized' });
  const codec = createCodec(client);
  const metrics = createMetrics({ service: 'indexer-test', version: '0.0.0' });
  const log = createLogger({ service: 'indexer-test', level: 'error' });
  const clock = options.clock ?? Date.now;
  const pipeline = createPipeline({ db, chain, codec, metrics, log, clock });
  const poller = createPoller({
    db,
    chain,
    pipeline,
    programIds,
    pageSize: options.pageSize ?? 1000,
    metrics,
    log,
    clock,
  });
  const reconciler = createReconciler({ db, chain, codec, pipeline, metrics, log, sampleSize: 5, clock });
  const queue = createWebhookQueue({
    chain,
    pipeline,
    maxPending: options.maxPending ?? 100,
    pendingTtlSeconds: options.pendingTtlSeconds ?? 60,
    metrics,
    log,
    clock,
  });
  return { programIds, chain, codec, metrics, log, pipeline, poller, reconciler, queue };
}
