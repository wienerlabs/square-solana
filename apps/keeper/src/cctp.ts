// CCTP relayer'ın keeper'daki turu (BE-26). Durum makinesi `@squaresdk/solana-cctp`'dedir; keeper ona cüzdanını
// (teslim tx'inin ücreti ve gerekirse kurumun USDC hesabının rent'i), priority fee kuralını (finalize ile aynı:
// yazılabilir hesapların son ücretlerinin yüzdeliği, üst sınırlı), metrikleri ve logları verir. Tek örnek keeper
// aynı mesajı iki kez göndermez; yarıda kalan tur bir sonraki turda zincirden anlaşılır.
import { createCctpRelayer, createTransferStore, type RelayerRound } from '@squaresdk/solana-cctp';
import type { PrismaClient } from '@squaresdk/solana-db';
import type { Logger } from '@squaresdk/solana-observability';
import type { SquareClient } from '@squaresdk/solana-sdk';
import type { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { CctpRelayerConfig } from './config.js';
import { percentile } from './crank.js';
import type { KeeperMetrics } from './metrics.js';

/** Priority fee: yazılabilir hesapların son ücretlerinin yüzdeliği, üst sınırlı. */
export function priorityFee(
  connection: Connection,
  economics: { readonly priorityFeePercentile: number; readonly maxComputeUnitPrice: bigint },
): (writable: readonly PublicKey[]) => Promise<bigint> {
  return async (writable) => {
    const recent = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: [...writable] });
    const fee = percentile(
      recent.map((entry) => BigInt(entry.prioritizationFee)),
      economics.priorityFeePercentile,
    );
    return fee > economics.maxComputeUnitPrice ? economics.maxComputeUnitPrice : fee;
  };
}

export interface CctpRound {
  runOnce(): Promise<RelayerRound>;
}

export function createCctpRound(deps: {
  db: PrismaClient;
  client: SquareClient;
  connection: Connection;
  keeper: Keypair;
  config: CctpRelayerConfig;
  economics: { readonly priorityFeePercentile: number; readonly maxComputeUnitPrice: bigint };
  batchSize: number;
  confirmPollMs: number;
  metrics: KeeperMetrics;
  log: Logger;
  onError: () => void;
}): CctpRound {
  const { config, metrics, log } = deps;
  const store = createTransferStore(deps.db);
  const relayer = createCctpRelayer({
    env: {
      client: deps.client,
      connection: deps.connection,
      programs: config.settings.programs,
      cctpLookupTables: config.settings.lookupTables,
      squareLookupTable: null,
    },
    store,
    payer: deps.keeper,
    attestationApi: config.attestationApi,
    relayAfterSeconds: config.relayAfterSeconds,
    backoff: config.backoff,
    batchSize: deps.batchSize,
    confirmPollMs: deps.confirmPollMs,
    computeUnitPrice: priorityFee(deps.connection, deps.economics),
    onTransition: (from, to, transfer) => {
      metrics.cctpTransitions.inc({ from, to });
      log.info('cctp_transition', {
        transfer: transfer.id,
        job: transfer.job,
        from,
        to,
        receiveSignature: transfer.receiveSignature,
        fundSignature: transfer.fundSignature,
        error: transfer.error,
      });
    },
    onError: (error, transfer) => {
      deps.onError();
      log.warn('cctp_step_failed', { transfer: transfer.id, status: transfer.status, error });
    },
  });
  return {
    async runOnce() {
      const round = await relayer.runOnce();
      for (const [status, count] of Object.entries(await store.openCounts())) {
        metrics.cctpOpen.set({ status }, count);
      }
      if (round.evaluated > 0) log.info('cctp_round', { ...round });
      return round;
    },
  };
}
