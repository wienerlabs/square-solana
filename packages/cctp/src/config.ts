// CCTP yapılandırması (API ve keeper ortak): Circle'ın iki programı ve kaynak domain başına CCTP ALT'ı. Üç
// değişken birlikte verilir ya da hiç verilmez; verilmezse CCTP fonlaması kapalıdır. ALT listesi
// `domain:adres` çiftleridir, virgülle (ör. `0:2Zg2…,6:…`); listedeki domain'ler desteklenen kaynaklardır.
import { PublicKey } from '@solana/web3.js';
import type { CctpPrograms } from '@squaresdk/solana-sdk';

export interface CctpSettings {
  readonly programs: CctpPrograms;
  readonly lookupTables: ReadonlyMap<number, PublicKey>;
}

export interface CctpSettingsInput {
  readonly messageTransmitter: string | undefined;
  readonly tokenMessengerMinter: string | undefined;
  readonly lookupTables: string | undefined;
}

export type CctpSettingsResult =
  | { readonly ok: true; readonly settings: CctpSettings | null }
  | { readonly ok: false; readonly problems: readonly string[] };

const U32_MAX = 4_294_967_295;
const blank = (value: string | undefined) => value === undefined || value.trim() === '';

function address(value: string, label: string, problems: string[]): PublicKey | null {
  try {
    return new PublicKey(value.trim());
  } catch {
    problems.push(`${label}: base58 adres bekleniyor`);
    return null;
  }
}

/** `names` hata mesajlarındaki değişken adlarıdır (ör. `API_CCTP_LOOKUP_TABLES`). */
export function parseCctpSettings(
  input: CctpSettingsInput,
  names: Record<keyof CctpSettingsInput, string>,
): CctpSettingsResult {
  const given = (Object.keys(input) as (keyof CctpSettingsInput)[]).filter((key) => !blank(input[key]));
  if (given.length === 0) return { ok: true, settings: null };
  const problems: string[] = [];
  if (given.length !== 3) {
    const missing = (Object.keys(names) as (keyof CctpSettingsInput)[]).filter((key) => blank(input[key]));
    problems.push(`${missing.map((key) => names[key]).join(', ')}: CCTP değişkenleri birlikte verilir`);
    return { ok: false, problems };
  }
  const messageTransmitter = address(input.messageTransmitter!, names.messageTransmitter, problems);
  const tokenMessengerMinter = address(input.tokenMessengerMinter!, names.tokenMessengerMinter, problems);
  const lookupTables = new Map<number, PublicKey>();
  for (const entry of input
    .lookupTables!.split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match = /^(\d{1,10}):(.+)$/.exec(entry);
    const domain = match ? Number(match[1]) : Number.NaN;
    if (!match || domain > U32_MAX) {
      problems.push(`${names.lookupTables}: "${entry}" domain:adres değil`);
      continue;
    }
    if (lookupTables.has(domain)) problems.push(`${names.lookupTables}: domain ${domain} iki kez verildi`);
    const table = address(match[2]!, `${names.lookupTables} (domain ${domain})`, problems);
    if (table) lookupTables.set(domain, table);
  }
  if (lookupTables.size === 0 && problems.length === 0)
    problems.push(`${names.lookupTables}: en az bir kaynak gerekli`);
  if (problems.length > 0 || !messageTransmitter || !tokenMessengerMinter) return { ok: false, problems };
  return { ok: true, settings: { programs: { messageTransmitter, tokenMessengerMinter }, lookupTables } };
}
