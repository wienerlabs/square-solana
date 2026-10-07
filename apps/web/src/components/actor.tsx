'use client';

// Rolün hesabı (FE-21): bir rolün zincirdeki adresi, işlemlerin ücret ödeyicisi ve gönderim yolu.
// - Cüzdan: rol adresi cüzdan, ücreti cüzdan öder (FE-03'teki korumalı gönderim).
// - Sponsorlu: rol adresi cüzdan, ücreti ve rent'i sponsor öder (BE-27). Tercih cüzdan başına, bu tarayıcıda.
// - Smart account: rol adresi Squads multisig'inin vault'u, ücreti sponsor öder; adım öneri ve yürütme olarak gider.
//   Seçim cüzdan ve rol başına (`smart-account.ts`). API'ye rol adına giden istekler `X-Square-Smart-Account`
//   başlığını taşır (`api`).
// Sponsor bilgisi (adres, tavanlar) servisin oturumlu ucundan okunur; ilk gerektiğinde oturum imzalatılır.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import {
  PublicKey,
  type AddressLookupTableAccount,
  type TransactionSignature,
  type VersionedTransaction,
} from '@solana/web3.js';
import { ENV_VARS } from '@/lib/config';
import { feePayerApi, unwrapSponsor, type SponsorInfo, type SponsorUsage } from '@/lib/fee-payer';
import { TransactionBlockedError } from '@/lib/send-transaction';
import {
  isSmartAccountRole,
  readSmartAccountChoice,
  writeSmartAccountChoice,
  type SmartAccountRole,
} from '@/lib/smart-account';
import { sendAsVault, sendSponsored, type MemberSigner, type SponsorChannel } from '@/lib/sponsored-send';
import type { Role } from '@/lib/roles';
import { useApiSession } from './api-session';
import { useNetworkGuard, useSendTransaction } from './network-guard';
import { useWebConfig } from './providers';

export type ActorMode = 'wallet' | 'sponsored' | 'smartAccount';

export interface Actor {
  /** Rolün zincirdeki adresi: cüzdan ya da smart account'un vault'u; cüzdan bağlı değilse null. */
  address: PublicKey | null;
  mode: ActorMode;
  /** Seçili smart account'un multisig adresi. */
  smartAccount: string | null;
  /** Sponsorlu gönderim ya da smart account kullanılamıyorsa sebebi; cüzdan modunda null. */
  problem: string | null;
  /**
   * SDK akışlarının ve tx kurucularının seçenekleri: ücret ve rent ödeyicisi. Sponsorlu modlarda sponsorun
   * adresidir (servisten, gerekirse oturum imzalatılarak okunur).
   */
  options(): Promise<{ feePayer: PublicKey }>;
  /** Rol adına gönderim; tx `options()`'ın ücret ödeyicisiyle kurulmuş olmalı. Dönen imza işi yapan tx'inkidir. */
  send(transaction: VersionedTransaction): Promise<TransactionSignature>;
  /** Rol adına API isteklerinin seçenekleri (`useApiSession().call`'ın ikinci argümanı). */
  api: { smartAccount: string | null };
}

interface ActorState {
  /** Sponsorlu gönderim yapılandırılmamışsa sebebi. */
  unavailable: string | null;
  sponsored: boolean;
  setSponsored(on: boolean): void;
  smartAccountOf(role: SmartAccountRole): string | null;
  setSmartAccount(role: SmartAccountRole, multisig: string | null): void;
  sponsorInfo(): Promise<SponsorInfo>;
  usage(): Promise<SponsorUsage>;
  channel(): Promise<SponsorChannel>;
  /** Dış işlemlerin ALT'ı: yapılandırılmışsa Square ALT'ı. */
  lookupTables(): Promise<AddressLookupTableAccount[]>;
}

const ActorContext = createContext<ActorState | null>(null);

export function useActorState(): ActorState {
  const state = useContext(ActorContext);
  if (!state) throw new Error('useActorState must be used inside <Providers>');
  return state;
}

const sponsoredKey = (wallet: string) => `square-sponsored:${wallet}`;

function readSponsored(wallet: string): boolean {
  try {
    return window.localStorage.getItem(sponsoredKey(wallet)) === '1';
  } catch {
    return false;
  }
}

function writeSponsored(wallet: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(sponsoredKey(wallet), '1');
    else window.localStorage.removeItem(sponsoredKey(wallet));
  } catch {
    // Kaydedilemezse tercih bu oturumla sınırlı kalır.
  }
}

interface Selection {
  wallet: string;
  sponsored: boolean;
  accounts: Partial<Record<SmartAccountRole, string>>;
}

const ROLES: readonly SmartAccountRole[] = ['institution', 'agent', 'buyer'];

export function ActorProvider({ children }: { children: ReactNode }) {
  const { feePayerUrl, apiUrl, lookupTable } = useWebConfig();
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const session = useApiSession();
  const wallet = publicKey?.toBase58() ?? null;
  const [selection, setSelection] = useState<Selection | null>(null);
  const info = useRef<Promise<SponsorInfo> | null>(null);
  const tables = useRef<Promise<AddressLookupTableAccount[]> | null>(null);

  // Depolama yalnızca tarayıcıda okunur; sunucu çıktısında seçim yoktur. Sponsor bilgisi oturuma bağlıdır.
  useEffect(() => {
    info.current = null;
    if (!wallet) {
      setSelection(null);
      return;
    }
    const accounts: Partial<Record<SmartAccountRole, string>> = {};
    for (const role of ROLES) {
      const multisig = readSmartAccountChoice(wallet, role);
      if (multisig) accounts[role] = multisig;
    }
    setSelection({ wallet, sponsored: readSponsored(wallet), accounts });
  }, [wallet]);

  const unavailable = !feePayerUrl
    ? `${ENV_VARS.feePayerUrl} is not set, so transactions cannot be sponsored.`
    : !apiUrl
      ? `${ENV_VARS.apiUrl} is not set; the sponsor accepts Square API sessions.`
      : null;

  const current = selection?.wallet === wallet ? selection : null;
  const { authorized } = session;

  const sponsorInfo = useCallback((): Promise<SponsorInfo> => {
    if (!feePayerUrl) return Promise.reject(new TransactionBlockedError(unavailable ?? undefined));
    if (!info.current) {
      const attempt = authorized((token) => feePayerApi(feePayerUrl, token).info()).then(unwrapSponsor);
      // Başarısız okuma önbellekte kalmaz.
      attempt.catch(() => {
        if (info.current === attempt) info.current = null;
      });
      info.current = attempt;
    }
    return info.current;
  }, [feePayerUrl, authorized, unavailable]);

  const usage = useCallback(async (): Promise<SponsorUsage> => {
    if (!feePayerUrl) throw new TransactionBlockedError(unavailable ?? undefined);
    return unwrapSponsor(await authorized((token) => feePayerApi(feePayerUrl, token).usage()));
  }, [feePayerUrl, authorized, unavailable]);

  const channel = useCallback(async (): Promise<SponsorChannel> => {
    if (!feePayerUrl) throw new TransactionBlockedError(unavailable ?? undefined);
    const known = await sponsorInfo();
    return {
      info: known,
      submit: async (transaction) =>
        unwrapSponsor(
          await authorized((token) =>
            feePayerApi(feePayerUrl, token).sponsor({
              transaction: Buffer.from(transaction.serialize()).toString('base64'),
              submit: true,
            }),
          ),
        ),
    };
  }, [feePayerUrl, authorized, sponsorInfo, unavailable]);

  const lookupTables = useCallback((): Promise<AddressLookupTableAccount[]> => {
    if (!lookupTable) return Promise.resolve([]);
    if (!tables.current) {
      const attempt = connection
        .getAddressLookupTable(new PublicKey(lookupTable), { commitment: 'confirmed' })
        .then(({ value }) => (value ? [value] : []));
      attempt.catch(() => {
        if (tables.current === attempt) tables.current = null;
      });
      tables.current = attempt;
    }
    return tables.current;
  }, [connection, lookupTable]);

  const setSponsored = useCallback(
    (on: boolean) => {
      if (!wallet) return;
      writeSponsored(wallet, on);
      setSelection((previous) => (previous?.wallet === wallet ? { ...previous, sponsored: on } : previous));
    },
    [wallet],
  );

  const setSmartAccount = useCallback(
    (role: SmartAccountRole, multisig: string | null) => {
      if (!wallet) return;
      writeSmartAccountChoice(wallet, role, multisig);
      setSelection((previous) => {
        if (previous?.wallet !== wallet) return previous;
        const accounts = { ...previous.accounts };
        if (multisig) accounts[role] = multisig;
        else delete accounts[role];
        return { ...previous, accounts };
      });
    },
    [wallet],
  );

  const value = useMemo<ActorState>(
    () => ({
      unavailable,
      sponsored: current?.sponsored ?? false,
      setSponsored,
      smartAccountOf: (role) => current?.accounts[role] ?? null,
      setSmartAccount,
      sponsorInfo,
      usage,
      channel,
      lookupTables,
    }),
    [unavailable, current, setSponsored, setSmartAccount, sponsorInfo, usage, channel, lookupTables],
  );
  return <ActorContext.Provider value={value}>{children}</ActorContext.Provider>;
}

/** Rolün hesabı. `role` null ya da smart account'la çalışmayan bir rolse cüzdan (ya da sponsorlu cüzdan) kullanılır. */
export function useActor(role: Role | null): Actor {
  const state = useActorState();
  const gate = useNetworkGuard();
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const sendGuarded = useSendTransaction();

  const smartAccount = isSmartAccountRole(role) ? state.smartAccountOf(role) : null;
  const mode: ActorMode = smartAccount ? 'smartAccount' : state.sponsored ? 'sponsored' : 'wallet';
  const vault = useMemo(
    () => (smartAccount ? squadsVaultAddress(new PublicKey(smartAccount), 0)[0] : null),
    [smartAccount],
  );
  const address = publicKey ? (vault ?? publicKey) : null;
  const problem = mode === 'wallet' ? null : state.unavailable;

  const signer = useCallback((): MemberSigner => {
    if (!publicKey) throw new TransactionBlockedError('Connect a wallet first.');
    if (!signTransaction) throw new TransactionBlockedError('The connected wallet cannot sign transactions.');
    return { publicKey, signTransaction };
  }, [publicKey, signTransaction]);

  const options = useCallback(async () => {
    if (!publicKey) throw new TransactionBlockedError('Connect a wallet first.');
    if (mode === 'wallet') return { feePayer: publicKey };
    if (problem) throw new TransactionBlockedError(problem);
    return { feePayer: new PublicKey((await state.sponsorInfo()).sponsor) };
  }, [publicKey, mode, problem, state]);

  const send = useCallback(
    async (transaction: VersionedTransaction): Promise<TransactionSignature> => {
      if (mode === 'wallet') return sendGuarded(transaction);
      if (problem) throw new TransactionBlockedError(problem);
      const channel = await state.channel();
      if (mode === 'sponsored') return sendSponsored(gate, channel, signer(), transaction);
      return sendAsVault(
        {
          connection,
          gate,
          channel,
          signer: signer(),
          multisig: new PublicKey(smartAccount!),
          lookupTables: await state.lookupTables(),
        },
        transaction,
      );
    },
    [mode, problem, sendGuarded, state, gate, signer, connection, smartAccount],
  );

  return useMemo(
    () => ({ address, mode, smartAccount, problem, options, send, api: { smartAccount } }),
    [address, mode, smartAccount, problem, options, send],
  );
}
