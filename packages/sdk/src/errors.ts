// Gönderim / simülasyon hatası → (program, kod, ad). Program hata kodları her programda 6000'den
// başladığından eşleme her zaman (program, kod) çiftiyle yapılır (api-sdk-contract.md §4).
import type { Idl } from '@anchor-lang/core';
import type { ProgramErrorRef } from '@squaresdk/solana-types';
import type { SquareProgramName } from './programs.js';

const FAILED = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error: 0x([0-9a-f]+)$/;
/** Anchor'ın hata logu: çerçeve hataları (ör. ConstraintSeeds, < 6000) da adıyla gelir. */
const ANCHOR_LOG = /^Program log: AnchorError .*Error Code: (\w+)\. Error Number: (\d+)\./;

export interface ErrorSource {
  name: SquareProgramName;
  programId: string;
  idl: Idl;
}

/** Hata nesnesinden log satırlarını çıkarır (SendTransactionError, AnchorError, simülasyon sonucu). */
function logsOf(error: unknown): readonly string[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { logs?: unknown; transactionLogs?: unknown; value?: { logs?: unknown } };
  for (const logs of [candidate.logs, candidate.transactionLogs, candidate.value?.logs]) {
    if (Array.isArray(logs) && logs.every((line) => typeof line === 'string')) return logs;
  }
  return null;
}

export function mapProgramError(sources: readonly ErrorSource[], error: unknown): ProgramErrorRef | null {
  const logs = logsOf(error);
  if (!logs) return null;
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const failed = FAILED.exec(logs[i]!);
    if (!failed) continue;
    const source = sources.find((s) => s.programId === failed[1]);
    if (!source) return null;
    const code = Number.parseInt(failed[2]!, 16);
    const fromIdl = (source.idl.errors ?? []).find((e) => e.code === code)?.name;
    const fromLog = logs
      .slice(0, i)
      .map((line) => ANCHOR_LOG.exec(line))
      .filter((match): match is RegExpExecArray => match !== null && Number(match[2]) === code)
      .at(-1)?.[1];
    const name = fromIdl ?? fromLog;
    if (!name) throw new Error(`${source.name}: ${code} kodlu hata IDL'de ve logda yok`);
    return { program: source.name, code, name };
  }
  return null;
}
