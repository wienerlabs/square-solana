// Delegasyonun Travel Rule kaydı (BE-23, ADR 0017). Kayıt hosted agent'ta tutulmaz: Square API'sine
// (`PUT /v1/jobs/{job}/travel-rule`) gönderilir. API kaydı zarf şifrelemesiyle saklar, salt'ı kendisi üretir ve
// `commit_travel_rule`'un commitment'ını döner. Uç kurumun güncel yetkilisinin oturumunu ister: oturum, kurumun
// keypair'iyle imzalanan meydan okumayla açılır (`/v1/auth/challenge` → `/v1/auth/session`) ve süresi dolana kadar
// yeniden kullanılır. Kişisel veri delegasyon defterine yazılmaz; defterde yalnızca commitment durur.
import { ed25519 } from '@noble/curves/ed25519.js';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import type { TravelRuleRecord } from '@squaresdk/solana-types';
import bs58 from 'bs58';

export interface TravelRuleStore {
  /** Kaydı saklar; zincire bağlanacak commitment'ı (64 hex) döner. Job zincirde `Open` olmalı. */
  put(job: PublicKey, record: TravelRuleRecord): Promise<string>;
}

/** Oturum süresinin bitmesine bu kadar saniye kala yenilenir. */
const SESSION_MARGIN_SECS = 30;

const failure = (what: string, error: { code: string; message: string }) =>
  new Error(`${what}: ${error.code}: ${error.message}`);

const SIGN_IN_MESSAGE =
  /^([a-z0-9.-]+(?::\d+)?) wants you to sign in with your Solana account:\n(\S+)\n\nSign in to Square\.\n\nNonce: (\S+)\nIssued At: (\S+)\nExpiration Time: (\S+)$/;

function isSquareSignIn(message: string, expected: { domain: string; wallet: string; nonce: string }): boolean {
  const match = SIGN_IN_MESSAGE.exec(message);
  return (
    match !== null &&
    match[1] === expected.domain &&
    match[2] === expected.wallet &&
    match[3] === expected.nonce &&
    !Number.isNaN(Date.parse(match[4]!)) &&
    !Number.isNaN(Date.parse(match[5]!))
  );
}

/** Square API'sinde saklayan Travel Rule deposu; kurumun keypair'iyle oturum açar. */
export function createApiTravelRuleStore(options: {
  baseUrl: string;
  authDomain: string;
  keypair: Keypair;
  fetch?: typeof fetch;
  /** Unix saniyesi. */
  now?: () => number;
}): TravelRuleStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const wallet = options.keypair.publicKey.toBase58();
  const anonymous = createApiClient({ baseUrl: options.baseUrl, ...(options.fetch && { fetch: options.fetch }) });
  let session: { api: SquareApi; expiresAt: number } | null = null;

  async function login(): Promise<SquareApi> {
    if (session && session.expiresAt - SESSION_MARGIN_SECS > now()) return session.api;
    const challenge = await anonymous.createAuthChallenge({ wallet });
    if (!challenge.success) throw failure('Travel Rule oturumu (challenge)', challenge.error);
    if (!isSquareSignIn(challenge.data.message, { domain: options.authDomain, wallet, nonce: challenge.data.nonce })) {
      throw new Error('Travel Rule oturumu: API bu cüzdan için Square oturum mesajı göndermedi; imzalanmadı');
    }
    const signature = ed25519.sign(
      new TextEncoder().encode(challenge.data.message),
      options.keypair.secretKey.slice(0, 32),
    );
    const opened = await anonymous.createSession({
      wallet,
      nonce: challenge.data.nonce,
      signature: bs58.encode(signature),
    });
    if (!opened.success) throw failure('Travel Rule oturumu', opened.error);
    const api = createApiClient({
      baseUrl: options.baseUrl,
      auth: { session: opened.data.token },
      ...(options.fetch && { fetch: options.fetch }),
    });
    session = { api, expiresAt: opened.data.expiresAt };
    return api;
  }

  return {
    async put(job, record) {
      const stored = await (await login()).putTravelRule(job.toBase58(), { record });
      if (!stored.success) {
        // Oturum sunucuda düşmüş olabilir: bir kez yeniden açılır.
        if (stored.error.code === 'unauthorized') {
          session = null;
          const retried = await (await login()).putTravelRule(job.toBase58(), { record });
          if (retried.success) return retried.data.commitment;
          throw failure('Travel Rule kaydı', retried.error);
        }
        throw failure('Travel Rule kaydı', stored.error);
      }
      return stored.data.commitment;
    },
  };
}
