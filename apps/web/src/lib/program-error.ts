// Gönderim ya da simülasyon hatasındaki program hata kodunun açıklaması, programın IDL'indeki `errors`
// listesinden. web3.js özel kodu `custom program error: 0x…` olarak yazar; kod hata mesajında ya da
// simülasyon loglarında olabilir.
import type { Idl } from '@anchor-lang/core';

/** Hata koduna karşılık gelen IDL mesajı ve adı; kod yoksa ya da bu IDL'de değilse null. */
export function programErrorMessage(idl: Pick<Idl, 'errors'>, error: unknown): string | null {
  const text = [error instanceof Error ? error.message : String(error), ...logsOf(error)].join('\n');
  const match = /custom program error: (0x[0-9a-f]+)/i.exec(text);
  if (!match) return null;
  const code = Number.parseInt(match[1]!, 16);
  const known = (idl.errors ?? []).find((entry) => entry.code === code);
  return known ? `${known.msg ?? known.name} (${known.name}, ${code})` : null;
}

function logsOf(error: unknown): string[] {
  const logs = (error as { logs?: unknown } | null)?.logs;
  return Array.isArray(logs) ? logs.filter((line): line is string => typeof line === 'string') : [];
}
