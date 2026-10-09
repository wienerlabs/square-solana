// Çağıran ve adına yazabildiği adresler (FE-21). Oturumun ya da API anahtarının cüzdanı kendi adına yazar. İstek
// `X-Square-Smart-Account: <multisig>` başlığını taşıyorsa çağıran o Squads v4 multisig'inin vault'u (indeks 0)
// adına da yazar; koşul, cüzdanın multisig'te öneri açabilen (`Initiate`) bir üye olmasıdır. Vault bir PDA'dır ve
// mesaj imzalayamaz: rol adresi smart account olan kurum, agent ya da alıcı API'ye üyesinin oturumuyla girer. Aynı
// kural, multisig'i `set_institution_multisig` ile bağlanmış kurumlarda zaten geçerlidir (institution-authority.ts);
// başlık onu vault'un doğrudan rol adresi olduğu hesaplara taşır.
// - Üyelik yalnızca gerektiğinde, denetlenen adres vault'a eşitse zincirden o anda okunur. Başlık tek başına yetki
//   vermez.
// - Kayıtlara (yükleyen, erişim kaydı, `updatedBy`) vault değil, işlemi yapan üyenin cüzdanı yazılır.
import { squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import { Address } from '@squaresdk/solana-types';
import { PublicKey, type Connection } from '@solana/web3.js';
import type { Response } from 'express';
import type { Principal } from './auth/service.js';
import { badRequest, parse } from './http.js';
import { isMultisigInitiator } from './squads.js';

/** İstek başlığı (OpenAPI `SmartAccount` parametresi). */
export const SMART_ACCOUNT_HEADER = 'x-square-smart-account';

export interface SmartAccountClaim {
  /** Squads v4 multisig hesabı. */
  readonly multisig: string;
  /** Multisig'in 0 numaralı vault PDA'sı (`squadsVaultAddress`). */
  readonly vault: string;
}

export interface Caller {
  /** Oturumun ya da API anahtarının cüzdanı. */
  readonly wallet: string;
  /** Başlıktaki smart account; üyelik henüz doğrulanmamıştır (`CallerAuthority.actsFor`). */
  readonly smartAccount: SmartAccountClaim | null;
}

export interface CallerAuthority {
  /** Çağıran, verilen adreslerden biri adına yazabilir mi. Boş (null) adresler yok sayılır. */
  actsFor(caller: Caller, ...addresses: readonly (string | null | undefined)[]): Promise<boolean>;
}

/** Başlığın değeri: multisig adresi ve vault'u; geçersiz adres 400. */
export function parseSmartAccount(value: string | undefined): SmartAccountClaim | null {
  if (value === undefined) return null;
  const address = parse(Address, value, 'X-Square-Smart-Account');
  let multisig: PublicKey;
  try {
    multisig = new PublicKey(address);
  } catch {
    throw badRequest('X-Square-Smart-Account geçersiz: 32 baytlık bir adres değil');
  }
  return { multisig: address, vault: squadsVaultAddress(multisig, 0)[0].toBase58() };
}

/**
 * Yetkisi denetlenmiş isteğin çağıranı. Başlık yalnızca onu kabul eden uçlarda okunur (OpenAPI `SmartAccount`
 * parametresi); geçersiz adres 400.
 */
export const callerOf = (res: Response, principal: Principal): Caller => ({
  wallet: principal.wallet,
  smartAccount: parseSmartAccount(res.req.get(SMART_ACCOUNT_HEADER)),
});

export function createCallerAuthority(deps: { connection: Connection }): CallerAuthority {
  return {
    async actsFor(caller, ...addresses) {
      if (addresses.includes(caller.wallet)) return true;
      const account = caller.smartAccount;
      if (!account || !addresses.includes(account.vault)) return false;
      return isMultisigInitiator(
        deps.connection,
        account.multisig,
        caller.wallet,
        'X-Square-Smart-Account bir Squads v4 multisig hesabı değil',
      );
    },
  };
}
