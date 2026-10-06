'use client';

// Square REST API oturumu (FE-17): cüzdanın Ed25519 imzasıyla açılan `/v1/auth` oturumu (apps/api "Kimlik").
// API imzalanacak metni verir; cüzdana yalnızca bu bağlı cüzdan için bir giriş mesajı imzalatılır (mesajın
// ikinci satırı cüzdan, içinde istenen nonce), işlem imzalatılmaz. Belirteç bu sekmenin `sessionStorage`'ında
// (`square-api-session:<api origin>:<cüzdan>`) süresi dolana kadar durur; sekme kapanınca silinir. Modül
// kendi içindedir: web'de API'ye bağlanan her sayfa (dispute, arbitrator konsolu) bunu kullanır.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { utils } from '@anchor-lang/core';
import { useWallet } from '@solana/wallet-adapter-react';
import { ApiClientError, createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import type { ApiEnvelope, ApiError, Session } from '@squaresdk/solana-types';

/** Belirtecin bitişine bu kadar saniye kala oturum geçersiz sayılır: istek yolda düşmesin. */
export const SESSION_EXPIRY_MARGIN_SECS = 30;

const STORAGE_PREFIX = 'square-api-session';
const SIGN_IN_HEADING = ' wants you to sign in with your Solana account:';

/** Başarısız API yanıtının hata nesnesi. */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

/** Başarılı zarfın verisi; başarısız zarf `ApiRequestError` olur. */
export function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.success) throw new ApiRequestError(envelope.error);
  return envelope.data;
}

/**
 * API'nin verdiği giriş mesajı bu cüzdan ve nonce için mi? Değilse sebebi. Cüzdan, alan adını ve süreyi
 * kullanıcı mesajın kendisinde görür; burada başka bir hesabın ya da başka bir isteğin mesajı reddedilir.
 */
export function signInMessageProblem(message: string, wallet: string, nonce: string): string | null {
  const lines = message.split('\n');
  if (!lines[0]?.endsWith(SIGN_IN_HEADING) || lines[0].length === SIGN_IN_HEADING.length)
    return 'The API sent something that is not a sign-in message.';
  if (lines[1] !== wallet) return 'The API asked to sign in another wallet.';
  if (!lines.includes(`Nonce: ${nonce}`)) return 'The sign-in message does not carry the nonce the API issued.';
  return null;
}

/** Cüzdanın mesaj imzası (wallet-adapter `signMessage`). */
export type MessageSigner = (message: Uint8Array) => Promise<Uint8Array>;

/** Challenge → cüzdan imzası → oturum. */
export async function signInWithWallet(api: SquareApi, wallet: string, signMessage: MessageSigner): Promise<Session> {
  const challenge = unwrap(await api.createAuthChallenge({ wallet }));
  const problem = signInMessageProblem(challenge.message, wallet, challenge.nonce);
  if (problem) throw new Error(problem);
  const signature = await signMessage(new TextEncoder().encode(challenge.message));
  const session = unwrap(
    await api.createSession({ wallet, nonce: challenge.nonce, signature: utils.bytes.bs58.encode(signature) }),
  );
  if (session.wallet !== wallet) throw new Error('The API opened a session for another wallet.');
  return session;
}

const storageKey = (apiUrl: string, wallet: string) => `${STORAGE_PREFIX}:${new URL(apiUrl).origin}:${wallet}`;

/** Bu sekmede saklı, süresi dolmamış oturum; yoksa ya da depolama erişilemezse null. */
export function readStoredSession(apiUrl: string, wallet: string, now: number): Session | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(apiUrl, wallet));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Session>;
    if (typeof value.token !== 'string' || value.wallet !== wallet || typeof value.expiresAt !== 'number') return null;
    return value.expiresAt - SESSION_EXPIRY_MARGIN_SECS > now ? (value as Session) : null;
  } catch {
    return null;
  }
}

export function storeSession(apiUrl: string, session: Session): void {
  try {
    window.sessionStorage.setItem(storageKey(apiUrl, session.wallet), JSON.stringify(session));
  } catch {
    // Saklanamazsa oturum bu sayfanın belleğiyle sınırlı kalır.
  }
}

export function forgetSession(apiUrl: string, wallet: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(apiUrl, wallet));
  } catch {
    // Depolama yoksa silinecek bir şey de yok.
  }
}

const API_ERROR_TEXT: Readonly<Record<ApiError['code'], string>> = {
  invalid_input: 'The API rejected the request as invalid.',
  unauthorized: 'The API session is missing or has expired; sign in again.',
  forbidden: 'The API does not allow this wallet to do that.',
  not_found: 'The API does not know this resource yet; the indexer may not have caught up.',
  conflict: 'The API refused because the state changed.',
  rate_limited: 'Too many requests; wait a moment and try again.',
  program_error: 'The program would reject this.',
  simulation_failed: 'The transaction fails in simulation.',
  rpc_unavailable: "The API cannot reach the chain's RPC right now.",
  db_unavailable: 'The API cannot reach its database right now.',
  prover_unavailable: 'The prover is unavailable.',
  internal_error: 'The API failed with an internal error.',
};

/**
 * API hatasının okunur metni. Zincir hatası (`programError`) varsa programın hata adı ve, verilirse,
 * ne yapılacağı (`programHint`); sunucunun kendi mesajı ayrıntı olarak eklenir.
 */
export function apiErrorText(error: unknown, programHint?: (name: string) => string | null): string {
  if (error instanceof ApiRequestError || (error instanceof ApiClientError && error.error)) {
    const detail = (error as ApiRequestError).error;
    const program = detail.programError;
    const base = API_ERROR_TEXT[detail.code] ?? detail.message;
    if (program) {
      const hint = programHint?.(program.name);
      return `${base} ${program.name} (${program.program}, ${program.code})${hint ? `: ${hint}` : '.'}`;
    }
    return `${base} (${detail.message})`;
  }
  if (error instanceof ApiClientError) return `The API answered unexpectedly (HTTP ${error.status}).`;
  if (error instanceof TypeError) return 'The Square API could not be reached.';
  return (error as Error).message;
}

const isUnauthorized = (error: unknown) =>
  (error instanceof ApiRequestError || error instanceof ApiClientError) &&
  (error instanceof ApiRequestError ? error.error.code === 'unauthorized' : error.status === 401);

export interface ApiSessionState {
  /** `SQUARE_API_URL` tanımlı değilse false: API'ye bağlı bölümler bunu söyler. */
  configured: boolean;
  /** Oturumsuz istemci (herkese açık okuma uçları). */
  publicApi: SquareApi | null;
  /** Oturumlu istemci; oturum yoksa null. */
  api: SquareApi | null;
  session: Session | null;
  /** Bağlı cüzdan mesaj imzalayabiliyor mu. */
  canSignIn: boolean;
  signingIn: boolean;
  error: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Hatanın metni; oturum geçersizse (401) yerel oturum da silinir. */
  report(error: unknown, programHint?: (name: string) => string | null): string;
}

export function useApiSession(apiUrl: string | undefined): ApiSessionState {
  const { publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [session, setSession] = useState<Session | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Saklı oturum yalnızca tarayıcıda okunur; cüzdan değişince o cüzdanın oturumuna geçilir.
  useEffect(() => {
    setError(null);
    setSession(apiUrl && wallet ? readStoredSession(apiUrl, wallet, Math.floor(Date.now() / 1000)) : null);
  }, [apiUrl, wallet]);

  const publicApi = useMemo(() => (apiUrl ? createApiClient({ baseUrl: apiUrl }) : null), [apiUrl]);
  const current = session && session.wallet === wallet ? session : null;
  const api = useMemo(
    () => (apiUrl && current ? createApiClient({ baseUrl: apiUrl, auth: { session: current.token } }) : null),
    [apiUrl, current],
  );

  const signIn = useCallback(async () => {
    if (!publicApi || !apiUrl || !wallet || !signMessage) return;
    setSigningIn(true);
    setError(null);
    try {
      const opened = await signInWithWallet(publicApi, wallet, signMessage);
      storeSession(apiUrl, opened);
      setSession(opened);
    } catch (caught) {
      setError(apiErrorText(caught));
    } finally {
      setSigningIn(false);
    }
  }, [publicApi, apiUrl, wallet, signMessage]);

  const signOut = useCallback(async () => {
    if (!apiUrl || !wallet) return;
    forgetSession(apiUrl, wallet);
    const closing = api;
    setSession(null);
    // Sunucudaki oturum da kapatılır; ulaşılamazsa belirteç süresi dolunca düşer.
    await closing?.deleteSession().catch(() => undefined);
  }, [api, apiUrl, wallet]);

  const report = useCallback(
    (caught: unknown, programHint?: (name: string) => string | null) => {
      if (isUnauthorized(caught) && apiUrl && wallet) {
        forgetSession(apiUrl, wallet);
        setSession(null);
      }
      return apiErrorText(caught, programHint);
    },
    [apiUrl, wallet],
  );

  return {
    configured: Boolean(apiUrl),
    publicApi,
    api,
    session: current,
    canSignIn: Boolean(signMessage && wallet && publicApi),
    signingIn,
    error,
    signIn,
    signOut,
    report,
  };
}
