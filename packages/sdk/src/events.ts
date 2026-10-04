// Tx loglarından Anchor event'lerini çözer. Loglar program çağrı yığınıyla birlikte yürünür; bir
// `Program data:` satırı yalnızca o anda çalışan program Square programlarından biriyse ve
// event'i o programın IDL'iyle çözülüyorsa alınır. Sıra logdaki sıradır (CPI'lar dahil).
import type { Coder, Idl } from '@anchor-lang/core';
import type { DecodedEvent, SquareEventName } from './types.js';

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const EXIT = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed\b.*)$/;
const DATA = /^Program data: (.+)$/;

export interface EventSource {
  programId: string;
  coder: Coder;
  idl: Idl;
}

export function decodeEventLogs(
  sources: readonly EventSource[],
  logs: readonly string[],
  context: { signature: string; slot: number },
): DecodedEvent[] {
  const byProgram = new Map(sources.map((source) => [source.programId, source]));
  const stack: string[] = [];
  const events: DecodedEvent[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
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
    });
  }
  return events;
}
