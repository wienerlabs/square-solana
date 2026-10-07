// Settlement token (USDC) hesabı ve miktarları. Mint'in kendisi zincirden okunur (settlement-config.ts);
// bu modül Anchor'a bağlı değildir.
import { getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import type { AccountInfo, PublicKey } from '@solana/web3.js';

export interface SettlementToken {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

/** Sahibin settlement token'ı için associated token account adresi. */
export function settlementAccount(owner: PublicKey, token: SettlementToken): PublicKey {
  // Sahip bir smart account'un vault'u (PDA, eğri dışı) olabilir (FE-21); ATA türetmesi aynıdır.
  return getAssociatedTokenAddressSync(token.mint, owner, true, token.tokenProgram);
}

/** Token hesabının bakiyesi (taban birim). Hesap yoksa ya da kapatılmışsa null. */
export function tokenAmount(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  token: SettlementToken,
): bigint | null {
  if (!info || info.data.length === 0) return null;
  return unpackAccount(address, info, token.tokenProgram).amount;
}

/**
 * Taban birimdeki miktarı ondalıkla, yuvarlamadan yazar (ör. 1234500000, 6 → "1,234.5").
 * `grouping: false` binlik ayırıcısız yazar; `parseUnits` bu biçimi geri okur.
 */
export function formatUnits(amount: bigint, decimals: number, { grouping = true } = {}): string {
  const base = 10n ** BigInt(decimals);
  const integer = amount / base;
  const whole = grouping ? integer.toLocaleString('en-US') : integer.toString();
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export type ParsedUnits = { ok: true; value: bigint } | { ok: false; error: string };

/**
 * Ondalıklı token miktarını taban birime çevirir, yalnızca tam sayı aritmetiğiyle (float yok):
 * "1250.5", 6 → 1250500000n. Mint'in ondalığından fazla basamak yuvarlanmaz, hatadır.
 */
export function parseUnits(text: string, decimals: number): ParsedUnits {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);
  if (!match) return { ok: false, error: 'Use digits and at most one decimal point, without separators.' };
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    return {
      ok: false,
      error:
        decimals === 0
          ? 'The mint has no decimal places.'
          : `At most ${decimals} decimal places: the mint's precision.`,
    };
  }
  return {
    ok: true,
    value: BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0'),
  };
}
