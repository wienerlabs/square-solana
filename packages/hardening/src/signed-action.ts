// İmzalı eylemler: cüzdan, bir HTTP isteğini (yöntem, yol, gövdenin SHA-256'sı) okunabilir bir mesajla
// imzalar; sunucu imzayı (Ed25519), alan adını, zamanı ve nonce'un tek kullanımlığını denetler. Mesaj
// cüzdanın göstereceği biçimdedir: alan adı ve eylem kullanıcıya görünür. İmza isteğe bağlıdır; başka bir
// uç noktaya, başka bir gövdeyle ya da ikinci kez kullanılamaz.
import { createHash, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import type { ReplayStore } from './stores.js';

export const SIGNED_ACTION_HEADERS = Object.freeze({
  wallet: 'x-square-wallet',
  signature: 'x-square-signature',
  nonce: 'x-square-nonce',
  issuedAt: 'x-square-issued-at',
});

export interface ActionMessageFields {
  domain: string;
  wallet: string;
  /** `YÖNTEM /yol?sorgu`. */
  action: string;
  /** Gövdenin SHA-256'sı (hex); gövdesiz istekte boş baytların özeti. */
  bodySha256: string;
  nonce: string;
  /** ISO 8601. */
  issuedAt: string;
}

/** Cüzdanın imzaladığı mesaj. */
export function actionMessage(fields: ActionMessageFields): string {
  return [
    `${fields.domain} wants you to sign a request with your Solana account:`,
    fields.wallet,
    '',
    `Action: ${fields.action}`,
    `Body SHA-256: ${fields.bodySha256}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ].join('\n');
}

export const bodySha256 = (body: string | Uint8Array | undefined): string =>
  createHash('sha256')
    .update(body ?? new Uint8Array())
    .digest('hex');

/** Mesaj imzalayabilen cüzdan (wallet-adapter `signMessage` ya da Keypair sarmalayıcısı). */
export interface MessageSigner {
  readonly publicKey: { toBase58(): string };
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** İmzalanan eylem: `YÖNTEM /yol?sorgu`. */
const actionOf = (method: string, pathAndQuery: string) => `${method.toUpperCase()} ${pathAndQuery}`;

/** İsteğin imza başlıkları. */
export async function signAction(params: {
  signer: MessageSigner;
  domain: string;
  method: string;
  url: URL;
  body?: string | Uint8Array;
  now?: Date;
}): Promise<Record<string, string>> {
  const wallet = params.signer.publicKey.toBase58();
  const nonce = randomBytes(16).toString('hex');
  const issuedAt = (params.now ?? new Date()).toISOString();
  const message = actionMessage({
    domain: params.domain,
    wallet,
    action: actionOf(params.method, `${params.url.pathname}${params.url.search}`),
    bodySha256: bodySha256(params.body),
    nonce,
    issuedAt,
  });
  const signature = await params.signer.signMessage(new TextEncoder().encode(message));
  return {
    [SIGNED_ACTION_HEADERS.wallet]: wallet,
    [SIGNED_ACTION_HEADERS.signature]: bs58.encode(signature),
    [SIGNED_ACTION_HEADERS.nonce]: nonce,
    [SIGNED_ACTION_HEADERS.issuedAt]: issuedAt,
  };
}

/** Her isteği imzalayan `fetch`; gövde dize ya da bayt olmalıdır. */
export function signedFetch(params: {
  signer: MessageSigner;
  domain: string;
  fetch?: typeof fetch;
}): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const send = params.fetch ?? fetch;
  return async (url, init = {}) => {
    const body = init.body ?? undefined;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw new Error('imzalı istekte gövde dize ya da Uint8Array olmalı');
    }
    const target = new URL(url);
    const signed = await signAction({
      signer: params.signer,
      domain: params.domain,
      method: init.method ?? 'GET',
      url: target,
      body: body ?? undefined,
    });
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(signed)) headers.set(name, value);
    return send(target, { ...init, headers });
  };
}

export type SignedActionFailure =
  'missing_headers' | 'invalid_wallet' | 'invalid_timestamp' | 'expired' | 'invalid_signature' | 'replayed';

export class SignedActionError extends Error {
  constructor(
    readonly reason: SignedActionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SignedActionError';
  }
}

const header = (headers: Readonly<Record<string, string | string[] | undefined>>, name: string) => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(entry) ? entry[0] : entry;
};

function decodeBase58(value: string, length: number): Uint8Array | null {
  try {
    const bytes = bs58.decode(value);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Gelen imzalı isteği doğrular ve imzalayan cüzdanı döner. İstek `maxAgeSeconds`'tan eski ya da
 * `clockSkewSeconds`'tan fazla ileri tarihli olamaz; nonce pencere süresince bir kez kabul edilir.
 */
export async function verifySignedAction(params: {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  domain: string;
  method: string;
  /** İsteğin yolu ve sorgusu, alındığı gibi (`/v1/x?y=1`; Express'te `req.originalUrl`). */
  path: string;
  body?: string | Uint8Array;
  maxAgeSeconds: number;
  clockSkewSeconds: number;
  replay: ReplayStore;
  now?: Date;
}): Promise<{ wallet: string }> {
  if (!params.path.startsWith('/')) throw new Error('path / ile başlamalı');
  const now = params.now ?? new Date();
  const wallet = header(params.headers, SIGNED_ACTION_HEADERS.wallet);
  const signature = header(params.headers, SIGNED_ACTION_HEADERS.signature);
  const nonce = header(params.headers, SIGNED_ACTION_HEADERS.nonce);
  const issuedAt = header(params.headers, SIGNED_ACTION_HEADERS.issuedAt);
  if (!wallet || !signature || !nonce || !issuedAt) {
    throw new SignedActionError('missing_headers', 'imza başlıkları eksik');
  }
  const publicKey = decodeBase58(wallet, 32);
  if (!publicKey) throw new SignedActionError('invalid_wallet', 'cüzdan adresi geçersiz');
  const issued = Date.parse(issuedAt);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(issuedAt) || Number.isNaN(issued)) {
    throw new SignedActionError('invalid_timestamp', 'imza zamanı ISO 8601 değil');
  }
  const age = (now.getTime() - issued) / 1000;
  if (age > params.maxAgeSeconds || age < -params.clockSkewSeconds) {
    throw new SignedActionError('expired', 'imzanın süresi dolmuş ya da zamanı ileride');
  }
  const message = actionMessage({
    domain: params.domain,
    wallet,
    action: actionOf(params.method, params.path),
    bodySha256: bodySha256(params.body),
    nonce,
    issuedAt,
  });
  const signatureBytes = decodeBase58(signature, 64);
  const valid = signatureBytes !== null && ed25519.verify(signatureBytes, new TextEncoder().encode(message), publicKey);
  if (!valid) throw new SignedActionError('invalid_signature', 'imza geçersiz');
  const expiresAt = new Date(issued + params.maxAgeSeconds * 1000);
  if (!(await params.replay.claim(`signed-action:${params.domain}`, `${wallet}:${nonce}`, expiresAt, now))) {
    throw new SignedActionError('replayed', 'bu imza daha önce kullanıldı');
  }
  return { wallet };
}
