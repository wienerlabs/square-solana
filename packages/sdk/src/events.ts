// Tx loglarından Anchor event'lerini çözer. Loglar program çağrı yığınıyla birlikte yürünür; bir
// `Program data:` satırı yalnızca o anda çalışan program Square programlarından biriyse ve
// event'i o programın IDL'iyle çözülüyorsa alınır. Sıra logdaki sıradır (CPI'lar dahil).
//
// Konum: event, yayımlandığı çağrının bağlı olduğu üst düzey talimatın sırasını (`instructionIndex`;
// CPI'lar üst talimatına sayılır) ve o talimattaki kendi sırasını (`eventIndex`) taşır. `(imza,
// instructionIndex, eventIndex)` event'i tx içinde tekil olarak adlandırır (indexer'ın anahtarı).
//
// Kırpılmış log: çalışma zamanı log sınırını aşan tx'in logunu `Log truncated` satırıyla keser. Kesilen
// kısmın event'leri okunamaz; `truncated` bunu bildirir, okunabilen event'ler yine döner.
import type { Coder, Idl } from '@anchor-lang/core';
import type { SquareProgramName } from './programs.js';
import type { DecodedEvent, SquareEventName } from './types.js';

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const EXIT = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed\b.*)$/;
const DATA = /^Program data: (.+)$/;
const TRUNCATED = 'Log truncated';

export interface EventSource {
  name: SquareProgramName;
  programId: string;
  coder: Coder;
  idl: Idl;
}

/** Tx içindeki konumuyla event. */
export interface LocatedEvent<N extends SquareEventName = SquareEventName> extends DecodedEvent<N> {
  /** Event'i yayımlayan Square programı. */
  program: SquareProgramName;
  /** Üst düzey talimatın tx'teki sırası (0'dan). */
  instructionIndex: number;
  /** Event'in aynı üst düzey talimattaki sırası (0'dan). */
  eventIndex: number;
}

export interface TransactionEvents {
  events: LocatedEvent[];
  /** Log `Log truncated` ile kesildi: kesilen kısmın event'leri eksik. */
  truncated: boolean;
}

export function decodeTransactionLogs(
  sources: readonly EventSource[],
  logs: readonly string[],
  context: { signature: string; slot: number },
): TransactionEvents {
  const byProgram = new Map(sources.map((source) => [source.programId, source]));
  const stack: string[] = [];
  const events: LocatedEvent[] = [];
  let instructionIndex = -1;
  let eventIndex = 0;
  for (const line of logs) {
    if (line === TRUNCATED) return { events, truncated: true };
    const invoke = INVOKE.exec(line);
    if (invoke) {
      if (invoke[2] === '1') {
        if (stack.length !== 0) throw new Error(`log yığını tutarsız: ${line}`);
        instructionIndex += 1;
        eventIndex = 0;
      }
      stack.push(invoke[1]!);
      continue;
    }
    const exit = EXIT.exec(line);
    if (exit) {
      if (stack.at(-1) !== exit[1]) throw new Error(`log yığını tutarsız: ${line}`);
      stack.pop();
      continue;
    }
    const data = DATA.exec(line);
    if (!data) continue;
    const source = byProgram.get(stack.at(-1) ?? '');
    if (!source) continue;
    const decoded = source.coder.events.decode(data[1]!);
    if (!decoded) {
      throw new Error(`${source.idl.metadata.name}: IDL'de olmayan event (${data[1]!.slice(0, 16)}…)`);
    }
    events.push({
      name: decoded.name as SquareEventName,
      data: decoded.data as DecodedEvent['data'],
      signature: context.signature,
      slot: context.slot,
      program: source.name,
      instructionIndex,
      eventIndex,
    });
    eventIndex += 1;
  }
  return { events, truncated: false };
}

export function decodeEventLogs(
  sources: readonly EventSource[],
  logs: readonly string[],
  context: { signature: string; slot: number },
): DecodedEvent[] {
  return decodeTransactionLogs(sources, logs, context).events.map(({ name, data, signature, slot }) => ({
    name,
    data,
    signature,
    slot,
  }));
}
