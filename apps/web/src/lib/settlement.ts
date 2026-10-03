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
  return getAssociatedTokenAddressSync(token.mint, owner, false, token.tokenProgram);
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

/** Taban birimdeki miktarı ondalıkla, yuvarlamadan yazar (ör. 1234500000, 6 → "1,234.5"). */
export function formatUnits(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = (amount / base).toLocaleString('en-US');
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
