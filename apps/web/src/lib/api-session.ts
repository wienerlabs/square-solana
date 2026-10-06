// Square API oturumu (FE-03, BE-18'in kimliği): API'nin verdiği Sign-In With Solana mesajı bağlı cüzdana
// imzalatılır, imza oturum belirtecine çevrilir (`createAuthChallenge` → `signMessage` → `createSession`).
// Belirteç `Authorization: Bearer` ile gider ve yalnızca bellekte durur. API'de yenileme ucu yoktur: oturumu
// yenilemek yeni bir imzadır. Bitmek üzere olan ya da API'nin reddettiği oturum bir sonraki istekte yeniden
// imzalatılır.
import type { PublicKey } from '@solana/web3.js';
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { Session } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { unwrap } from './square-api';

/** Oturumun bitmesine bu kadar kala yeni imza istenir (saniye): istek yoldayken süresi dolmasın. */
export const SESSION_RENEW_MARGIN_SECS = 60;

/** Oturum bu cüzdanla şimdi kullanılabilir mi (bitmesine `SESSION_RENEW_MARGIN_SECS`'ten fazla var mı)? */
export const sessionUsable = (session: Session | null, wallet: string | null, now: number): boolean =>
  session !== null && session.wallet === wallet && session.expiresAt - now > SESSION_RENEW_MARGIN_SECS;

const INTRO = /^(\S+) wants you to sign in with your Solana account:$/;

/**
 * İmzalanacak mesaj bu sayfa ve bu cüzdan için mi? API'nin mesajı Sign-In With Solana biçimindedir: ilk
 * satırı alan adı (`API_AUTH_DOMAIN`), ikinci satırı cüzdan. Başka bir alan adı ya da cüzdan için mesaj
 * imzalatılmaz: imza o alan adında bu cüzdanın oturumunu açardı.
 */
export function signInMessageProblem(message: string, expected: { domain: string; wallet: string }): string | null {
  const [intro = '', wallet = ''] = message.split('\n');
  const domain = INTRO.exec(intro)?.[1];
  if (!domain) return 'The Square API sent a sign-in message in an unknown format, so it is not signed.';
  if (domain !== expected.domain) {
    return `The Square API asks to sign in for ${domain}, but this page is ${expected.domain}; the message is not signed.`;
  }
  if (wallet !== expected.wallet) return `The sign-in message names another wallet (${wallet}), so it is not signed.`;
  return null;
}

/** Bağlı cüzdanla yeni oturum: challenge, mesajın denetimi, cüzdanın imzası, belirteç. */
export async function signInToApi(params: {
  api: SquareApi;
  wallet: PublicKey;
  /** Sayfanın alan adı (`location.host`). */
  domain: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}): Promise<Session> {
  const wallet = params.wallet.toBase58();
  const challenge = unwrap(await params.api.createAuthChallenge({ wallet }));
  const problem = signInMessageProblem(challenge.message, { domain: params.domain, wallet });
  if (problem) throw new Error(problem);
  const signature = await params.signMessage(new TextEncoder().encode(challenge.message));
  return unwrap(await params.api.createSession({ wallet, nonce: challenge.nonce, signature: bs58.encode(signature) }));
}
