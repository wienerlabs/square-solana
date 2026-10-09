'use client';

import { useCallback, useMemo, useState } from 'react';
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { Session } from '@squaresdk/solana-types';
import { useApiSession } from '@/components/api-session';
import { useWebConfig } from '@/components/providers';
import { sessionUsable } from '@/lib/api-session';
import { apiErrorText, isUnauthorized, squareApi } from '@/lib/square-api';

export interface ApiClientState {
  configured: boolean;
  publicApi: SquareApi | null;
  api: SquareApi | null;
  session: Session | null;
  canSignIn: boolean;
  unavailable: string | null;
  signingIn: boolean;
  error: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  report(error: unknown, programHint?: (name: string) => string | null): string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const SESSION_REJECTED = 'The session is no longer valid. Sign in again.';

/**
 * Oturumlu API istemcisi. `smartAccount` verilirse istekler o smart account'un vault'u adına gider
 * (`X-Square-Smart-Account`, FE-21).
 */
export function useApiClient(options?: { smartAccount?: string | null }): ApiClientState {
  const { apiUrl } = useWebConfig();
  const { session, unavailable, signingIn, error, signIn, signOut } = useApiSession();
  const [rejected, setRejected] = useState<string | null>(null);
  const live =
    session && session.token !== rejected && sessionUsable(session, session.wallet, nowSeconds()) ? session : null;
  const token = live?.token ?? null;
  const dropped = session !== null && session.token === rejected;
  const publicApi = useMemo(() => (apiUrl ? squareApi(apiUrl) : null), [apiUrl]);
  const smartAccount = options?.smartAccount ?? null;
  const api = useMemo(
    () => (apiUrl && token ? squareApi(apiUrl, token, smartAccount) : null),
    [apiUrl, token, smartAccount],
  );
  const open = useCallback(
    () =>
      signIn().then(
        () => undefined,
        () => undefined,
      ),
    [signIn],
  );
  const report = useCallback(
    (failure: unknown, programHint?: (name: string) => string | null) => {
      if (token && isUnauthorized(failure)) setRejected(token);
      return apiErrorText(failure, programHint);
    },
    [token],
  );
  return useMemo(
    () => ({
      configured: Boolean(apiUrl),
      publicApi,
      api,
      session: live,
      canSignIn: unavailable === null,
      unavailable,
      signingIn,
      error: error ?? (dropped ? SESSION_REJECTED : null),
      signIn: open,
      signOut,
      report,
    }),
    [apiUrl, publicApi, api, live, unavailable, signingIn, error, dropped, open, signOut, report],
  );
}
