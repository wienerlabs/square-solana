'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { ApiEnvelope, Session } from '@squaresdk/solana-types';
import { sessionUsable, signInToApi } from '@/lib/api-session';
import { ENV_VARS } from '@/lib/config';
import { squareApi, unwrap } from '@/lib/square-api';

export interface ApiSessionState {
  /** Oturum açılamıyorsa sebebi: API yapılandırılmamış, cüzdan bağlı değil ya da cüzdan mesaj imzalayamıyor. */
  unavailable: string | null;
  /** Bağlı cüzdanın oturumu; süresi dolmuş olabilir (`sessionUsable`). */
  session: Session | null;
  signingIn: boolean;
  /** Son oturum açma ya da kapatma denemesinin hatası. */
  error: string | null;
  signIn(): Promise<Session>;
  signOut(): Promise<void>;
  /**
   * Oturumlu API çağrısı. Oturum yoksa ya da bitmek üzereyse önce cüzdana imzalatılır; API eldeki oturumu
   * reddederse (`unauthorized`: süresi dolmuş ya da kapatılmış) bir kez yeniden imzalatılıp tekrarlanır.
   */
  call<T>(request: (api: SquareApi) => Promise<ApiEnvelope<T>>): Promise<T>;
}

const ApiSessionContext = createContext<ApiSessionState | null>(null);

export function useApiSession(): ApiSessionState {
  const state = useContext(ApiSessionContext);
  if (!state) throw new Error('useApiSession must be used inside <Providers>');
  return state;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Square API oturumu (FE-03): belirteç yalnızca bellekte, bağlı cüzdana bağlı. */
export function ApiSessionProvider({ apiUrl, children }: { apiUrl: string | undefined; children: ReactNode }) {
  const { publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [session, setSession] = useState<Session | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // İstekler son oturumu ve bağlı cüzdanı render'ı beklemeden görür; aynı anda gelen imza istekleri tek
  // imzada birleşir.
  const held = useRef<Session | null>(null);
  const connected = useRef(wallet);
  const pending = useRef<Promise<Session> | null>(null);
  useEffect(() => {
    connected.current = wallet;
  }, [wallet]);

  const keep = useCallback((next: Session | null) => {
    held.current = next;
    setSession(next);
  }, []);

  // Cüzdan değişince ya da bağlantı kopunca önceki cüzdanın oturumu bırakılır ve API'de kapatılır.
  useEffect(() => {
    const previous = held.current;
    if (!previous || previous.wallet === wallet) return;
    keep(null);
    setError(null);
    if (apiUrl)
      squareApi(apiUrl, previous.token)
        .deleteSession()
        .catch(() => undefined);
  }, [wallet, apiUrl, keep]);

  const unavailable = !apiUrl
    ? `${ENV_VARS.apiUrl} is not set.`
    : !publicKey
      ? 'Connect a wallet to sign in.'
      : !signMessage
        ? 'This wallet cannot sign messages, so it cannot sign in to the Square API.'
        : null;

  const signIn = useCallback((): Promise<Session> => {
    if (pending.current) return pending.current;
    if (!apiUrl || !publicKey || !signMessage) return Promise.reject(new Error(unavailable ?? undefined));
    setSigningIn(true);
    setError(null);
    const attempt = signInToApi({
      api: squareApi(apiUrl),
      wallet: publicKey,
      domain: window.location.host,
      signMessage,
    })
      .then((next) => {
        // İmza beklenirken cüzdan değiştiyse oturum o cüzdana aittir, kullanılmaz.
        if (next.wallet !== connected.current) throw new Error('The wallet changed while signing in.');
        keep(next);
        return next;
      })
      .catch((failure: Error) => {
        setError(failure.message);
        throw failure;
      })
      .finally(() => {
        pending.current = null;
        setSigningIn(false);
      });
    pending.current = attempt;
    return attempt;
  }, [unavailable, apiUrl, publicKey, signMessage, keep]);

  const signOut = useCallback(async () => {
    const previous = held.current;
    keep(null);
    setError(null);
    if (!previous || !apiUrl) return;
    try {
      await squareApi(apiUrl, previous.token).deleteSession();
    } catch (failure) {
      setError(`The session is dropped here, but the Square API could not close it: ${(failure as Error).message}`);
    }
  }, [apiUrl, keep]);

  const call = useCallback(
    async <T,>(request: (api: SquareApi) => Promise<ApiEnvelope<T>>): Promise<T> => {
      if (!apiUrl) throw new Error(`${ENV_VARS.apiUrl} is not set.`);
      const current = held.current;
      const reused = sessionUsable(current, connected.current, nowSeconds());
      const first = reused && current ? current : await signIn();
      const envelope = await request(squareApi(apiUrl, first.token));
      if (envelope.success || envelope.error.code !== 'unauthorized' || !reused) return unwrap(envelope);
      // API eldeki oturumu kabul etmedi (süresi dolmuş ya da kapatılmış): yeni imzayla bir kez daha.
      keep(null);
      const renewed = await signIn();
      return unwrap(await request(squareApi(apiUrl, renewed.token)));
    },
    [apiUrl, signIn, keep],
  );

  const value = useMemo<ApiSessionState>(
    () => ({
      unavailable,
      session: session?.wallet === wallet ? session : null,
      signingIn,
      error,
      signIn,
      signOut,
      call,
    }),
    [unavailable, session, wallet, signingIn, error, signIn, signOut, call],
  );
  return <ApiSessionContext.Provider value={value}>{children}</ApiSessionContext.Provider>;
}
