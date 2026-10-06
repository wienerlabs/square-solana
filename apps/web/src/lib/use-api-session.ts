'use client';

// Square API oturumu (FE-22): bağlı cüzdan challenge metnini imzalar, belirteç yalnızca bellekte tutulur.
// Cüzdan değişince, oturumun süresi dolunca ya da API `unauthorized` dönünce oturum kapanır.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClientError, createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import { PortalApiError, signInToApi, type ApiSession } from './developer-portal';

export type SessionState =
  | { state: 'signedOut'; error: string | null }
  | { state: 'signingIn' }
  | { state: 'signedIn'; session: ApiSession; api: SquareApi };

export interface ApiSessionControls {
  session: SessionState;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** API çağrısının hatası: `unauthorized` oturumu kapatır. Gösterilecek mesajı döner. */
  failed(error: unknown): string;
}

export function useApiSession(params: {
  apiUrl: string;
  wallet: string | null;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
  fetch?: typeof fetch;
}): ApiSessionControls {
  const { apiUrl, wallet, signMessage, fetch: send } = params;
  const anonymous = useMemo(
    () => createApiClient({ baseUrl: apiUrl, ...(send ? { fetch: send } : {}) }),
    [apiUrl, send],
  );
  const [session, setSession] = useState<SessionState>({ state: 'signedOut', error: null });

  // Başka cüzdana geçilince önceki cüzdanın oturumu kullanılmaz.
  useEffect(() => {
    setSession({ state: 'signedOut', error: null });
  }, [wallet, apiUrl]);

  // Süresi dolan oturum kendiliğinden kapanır.
  const expiresAt = session.state === 'signedIn' ? session.session.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(
      () => setSession({ state: 'signedOut', error: 'The session expired. Sign in again.' }),
      // setTimeout 2^31-1 ms üstünü hemen çalıştırır.
      Math.min(2 ** 31 - 1, Math.max(0, expiresAt * 1000 - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const signIn = useCallback(async () => {
    if (!wallet) return;
    if (!signMessage) {
      setSession({ state: 'signedOut', error: 'This wallet cannot sign messages, so it cannot sign in to the API.' });
      return;
    }
    setSession({ state: 'signingIn' });
    try {
      const signed = await signInToApi({ api: anonymous, wallet, signMessage });
      const api = createApiClient({
        baseUrl: apiUrl,
        auth: { session: signed.token },
        ...(send ? { fetch: send } : {}),
      });
      setSession({ state: 'signedIn', session: signed, api });
    } catch (error) {
      setSession({ state: 'signedOut', error: `Sign-in failed: ${(error as Error).message}` });
    }
  }, [anonymous, apiUrl, send, signMessage, wallet]);

  const signOut = useCallback(async () => {
    if (session.state === 'signedIn') {
      // Sunucudaki oturum da kapatılır; kapatılamasa da belirteç sayfadan silinir.
      await session.api.deleteSession().catch(() => undefined);
    }
    setSession({ state: 'signedOut', error: null });
  }, [session]);

  const failed = useCallback((error: unknown) => {
    // Zarflı yanıtın hatası `PortalApiError`, gövdesiz (204) uçlarınki `ApiClientError`'dır.
    const unauthorized =
      (error instanceof PortalApiError && error.code === 'unauthorized') ||
      (error instanceof ApiClientError && error.status === 401);
    if (unauthorized) {
      setSession({ state: 'signedOut', error: 'The session is no longer valid. Sign in again.' });
    }
    return (error as Error).message;
  }, []);

  return { session, signIn, signOut, failed };
}
