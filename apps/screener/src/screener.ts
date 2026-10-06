// Tarama: kaynaklar birlikte sorulur, karar birleştirilir (evidence.ts), `record_screening` tx'i screener
// authority anahtarıyla gönderilir ve her karar denetim kaydına yazılır. Kaynaklardan biri yanıt vermezse
// karar verilmez ve tx gönderilmez (fail-closed): zincirdeki eski kayıt süresi dolunca escrow'u durdurur
// (`ScreeningExpired`), yanlış bir `Clear` yazılmaz. Aynı cüzdanın eşzamanlı taramaları (API ve yenileme)
// tek taramayı paylaşır: aynı karar için iki tx gönderilmez.
import type { EventWindow, Logger } from '@squaresdk/solana-observability';
import type { ProgramErrorRef } from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import { ScreeningTxError, type RecordedScreening, type ScreeningChain } from './chain.js';
import { decide } from './evidence.js';
import type { ScreenerMetrics } from './metrics.js';
import type { ScreeningSource, SourceResult } from './sources/source.js';
import type { DecisionRow, DecisionStore, NewDecision } from './store.js';

export interface ScreenContext {
  readonly trigger: 'request' | 'renewal';
  /** API anahtarının parmak izi; yenilemede null. */
  readonly caller: string | null;
}

/** Karar verilemedi (`source`) ya da tx yazılamadı (`tx`); denetim kaydı yazılmıştır. */
export class ScreeningFailedError extends Error {
  constructor(
    readonly kind: 'source' | 'tx',
    readonly decision: DecisionRow,
    readonly programError: ProgramErrorRef | null = null,
  ) {
    super(decision.error ?? kind);
    this.name = 'ScreeningFailedError';
  }
}

export interface Screener {
  /** Taramayı yapar ve onaylanmış kararı döner; başarısızlıkta `ScreeningFailedError`. */
  screen(wallet: string, context: ScreenContext): Promise<DecisionRow>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export function createScreener(deps: {
  sources: readonly ScreeningSource[];
  chain: Pick<ScreeningChain, 'recordScreening'>;
  store: DecisionStore;
  metrics: ScreenerMetrics;
  log: Logger;
  /** Hatalar (`screener_errors` alarmının değeri). */
  errors: EventWindow;
  clock?: () => number;
}): Screener {
  if (deps.sources.length === 0) throw new Error('en az bir tarama kaynağı gerekli');
  const { store, metrics, log } = deps;
  const clock = deps.clock ?? Date.now;
  const inFlight = new Map<string, Promise<DecisionRow>>();

  async function write(decision: NewDecision): Promise<DecisionRow> {
    metrics.decisions.inc({ trigger: decision.trigger, outcome: decision.outcome, status: decision.status ?? 'none' });
    try {
      return await store.insert(decision);
    } catch (error) {
      // Zincire yazılmış kararın denetim satırı kaybolmasın: log ikinci kayıttır.
      log.error('audit_write_failed', { decision: { ...decision, sources: undefined }, error });
      throw error;
    }
  }

  async function run(wallet: string, context: ScreenContext): Promise<DecisionRow> {
    const walletKey = new PublicKey(wallet);
    const base = { wallet, trigger: context.trigger, caller: context.caller } as const;
    const settled = await Promise.allSettled(deps.sources.map((source) => source.check(wallet)));
    const results: SourceResult[] = [];
    const failures: string[] = [];
    const sources = settled.map((outcome, index) => {
      const source = deps.sources[index]!.name;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        metrics.sourceChecks.inc({ source, result: outcome.value.flagged ? 'flagged' : 'clear' });
        return { source, flagged: outcome.value.flagged, ...outcome.value.evidence };
      }
      metrics.sourceChecks.inc({ source, result: 'error' });
      failures.push(`${source}: ${message(outcome.reason)}`);
      return { source, error: message(outcome.reason) };
    });

    if (failures.length > 0) {
      deps.errors.record();
      log.warn('screening_source_error', { wallet, trigger: context.trigger, failures });
      const row = await write({
        ...base,
        outcome: 'sourceError',
        status: null,
        sources,
        evidence: null,
        sourceHash: null,
        signature: null,
        slot: null,
        screenedAt: null,
        expiresAt: null,
        error: failures.join('; '),
        at: new Date(clock()),
      });
      throw new ScreeningFailedError('source', row);
    }

    const decision = decide(wallet, results);
    const decided = {
      ...base,
      status: decision.status,
      sources,
      evidence: decision.evidence as unknown as NewDecision['evidence'],
      sourceHash: hex(decision.sourceHash),
    };
    let recorded: RecordedScreening;
    try {
      recorded = await deps.chain.recordScreening({
        wallet: walletKey,
        status: decision.status,
        sourceHash: decision.sourceHash,
      });
    } catch (error) {
      deps.errors.record();
      const txError = error instanceof ScreeningTxError ? error : null;
      log.warn('screening_tx_failed', { wallet, trigger: context.trigger, error });
      const row = await write({
        ...decided,
        outcome: 'txFailed',
        signature: txError?.signature ?? null,
        slot: null,
        screenedAt: null,
        expiresAt: null,
        error: message(error),
        at: new Date(clock()),
      });
      throw new ScreeningFailedError('tx', row, txError?.programError ?? null);
    }
    if (hex(recorded.record.sourceHash) !== decided.sourceHash || recorded.record.status !== decision.status) {
      // Tx'ten sonra aynı kayda başka bir yazma (ikinci bir screener örneği) geldi.
      log.warn('screening_record_mismatch', { wallet, signature: recorded.signature });
    }
    const row = await write({
      ...decided,
      outcome: 'recorded',
      signature: recorded.signature,
      slot: recorded.slot,
      screenedAt: recorded.record.screenedAt,
      expiresAt: recorded.record.expiresAt,
      error: null,
      at: new Date(clock()),
    });
    log.info('screening_recorded', {
      wallet,
      trigger: context.trigger,
      status: decision.status,
      signature: recorded.signature,
      expiresAt: recorded.record.expiresAt,
    });
    return row;
  }

  return {
    screen(wallet, context) {
      const current = inFlight.get(wallet);
      if (current) return current;
      const promise = run(wallet, context).finally(() => inFlight.delete(wallet));
      inFlight.set(wallet, promise);
      return promise;
    },
  };
}
