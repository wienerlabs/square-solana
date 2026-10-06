// Cüzdan Ed25519 oturumu ve API anahtarları (api-sdk-contract §5, §8.4).
// - Challenge: cüzdan, alan adını, nonce'u ve süreyi içeren okunabilir mesajı imzalar (Sign-In With Solana
//   biçimi). Nonce tek kullanımlıktır; tüketim tek bir koşullu güncellemedir (aynı imza ikinci oturum açamaz).
// - Oturum belirteci `sqs_` + 32 rastgele bayt (base64url); veritabanında yalnızca SHA-256'sı durur.
// - API anahtarı `sqk_` + 32 rastgele bayt; yalnızca SHA-256'sı ve ilk 12 karakteri (`prefix`) saklanır, gizli
//   değer yalnızca oluşturma yanıtında bir kez döner.
import { createHash, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { ApiKeyScope as DbScope, PrismaClient } from '@squaresdk/solana-db';
import type {
  ApiKey,
  ApiKeyCreate,
  ApiKeyScope,
  AuthChallenge,
  Session,
  SessionRequest,
} from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { notFound, unauthorized } from '../http.js';

const SESSION_PREFIX = 'sqs_';
const API_KEY_PREFIX = 'sqk_';
const SECRET_BYTES = 32;
const NONCE_BYTES = 16;
/** Listelemede gösterilen baş kısım: önek + 8 karakter. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SCOPE_TO_DB: Readonly<Record<ApiKeyScope, DbScope>> = {
  read: 'read',
  'tx:prepare': 'txPrepare',
  'deliveries:write': 'deliveriesWrite',
  'agents:write': 'agentsWrite',
  prove: 'prove',
  'disputes:write': 'disputesWrite',
};
const SCOPE_FROM_DB = Object.fromEntries(Object.entries(SCOPE_TO_DB).map(([wire, db]) => [db, wire])) as Readonly<
  Record<DbScope, ApiKeyScope>
>;

export type Principal =
  | { readonly kind: 'session'; readonly wallet: string; readonly sessionId: string }
  | {
      readonly kind: 'apiKey';
      readonly wallet: string;
      readonly keyId: string;
      readonly scopes: readonly ApiKeyScope[];
    };

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (prefix: string) => `${prefix}${randomBytes(SECRET_BYTES).toString('base64url')}`;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** Cüzdanın imzaladığı oturum mesajı. */
export function signInMessage(fields: {
  domain: string;
  wallet: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  return [
    `${fields.domain} wants you to sign in with your Solana account:`,
    fields.wallet,
    '',
    'Sign in to Square.',
    '',
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expiration Time: ${fields.expiresAt.toISOString()}`,
  ].join('\n');
}

/** Base58 Ed25519 imzası; bozuk kodlama ya da anahtar geçersiz imzadır. */
function verifySignature(signature: string, message: string, wallet: string): boolean {
  try {
    return ed25519.verify(bs58.decode(signature), new TextEncoder().encode(message), bs58.decode(wallet));
  } catch {
    return false;
  }
}

const apiKeyView = (row: {
  id: string;
  label: string;
  prefix: string;
  scopes: DbScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
}): ApiKey => ({
  id: row.id,
  label: row.label,
  prefix: row.prefix,
  scopes: row.scopes.map((scope) => SCOPE_FROM_DB[scope]),
  createdAt: seconds(row.createdAt),
  lastUsedAt: row.lastUsedAt === null ? null : seconds(row.lastUsedAt),
});

export interface AuthService {
  createChallenge(wallet: string): Promise<AuthChallenge>;
  createSession(request: SessionRequest): Promise<Session>;
  revokeSession(sessionId: string): Promise<void>;
  listApiKeys(wallet: string): Promise<ApiKey[]>;
  createApiKey(wallet: string, request: ApiKeyCreate): Promise<{ apiKey: ApiKey; secret: string }>;
  revokeApiKey(wallet: string, id: string): Promise<void>;
  /** Başlıklardan istek sahibi; kimlik verilmemişse null, geçersizse 401. */
  principal(credentials: { bearer: string | null; apiKey: string | null }): Promise<Principal | null>;
}

export function createAuthService(deps: {
  db: PrismaClient;
  domain: string;
  challengeTtlSeconds: number;
  sessionTtlSeconds: number;
  clock?: () => number;
}): AuthService {
  const { db } = deps;
  const clock = deps.clock ?? Date.now;

  return {
    async createChallenge(wallet) {
      const issuedAt = new Date(clock());
      const expiresAt = new Date(issuedAt.getTime() + deps.challengeTtlSeconds * 1000);
      const nonce = randomBytes(NONCE_BYTES).toString('base64url');
      const message = signInMessage({ domain: deps.domain, wallet, nonce, issuedAt, expiresAt });
      await db.$transaction([
        db.user.upsert({ where: { wallet }, create: { wallet }, update: {} }),
        db.authChallenge.create({ data: { nonce, wallet, message, expiresAt } }),
      ]);
      return { nonce, message, expiresAt: seconds(expiresAt) };
    },

    async createSession(request) {
      const now = new Date(clock());
      const challenge = await db.authChallenge.findUnique({ where: { nonce: request.nonce } });
      if (!challenge || challenge.wallet !== request.wallet || challenge.consumedAt || challenge.expiresAt <= now) {
        throw unauthorized('challenge geçersiz, kullanılmış ya da süresi dolmuş');
      }
      if (!verifySignature(request.signature, challenge.message, request.wallet)) throw unauthorized('imza geçersiz');
      const token = secret(SESSION_PREFIX);
      const expiresAt = new Date(now.getTime() + deps.sessionTtlSeconds * 1000);
      await db.$transaction(async (tx) => {
        const consumed = await tx.authChallenge.updateMany({
          where: { nonce: challenge.nonce, consumedAt: null },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) throw unauthorized('challenge kullanılmış');
        await tx.session.create({ data: { wallet: request.wallet, tokenHash: sha256Hex(token), expiresAt } });
        await tx.user.update({ where: { wallet: request.wallet }, data: { lastSeenAt: now } });
      });
      return { token, wallet: request.wallet, expiresAt: seconds(expiresAt) };
    },

    async revokeSession(sessionId) {
      await db.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(clock()) },
      });
    },

    async listApiKeys(wallet) {
      const rows = await db.apiKey.findMany({ where: { wallet, revokedAt: null }, orderBy: { createdAt: 'desc' } });
      return rows.map(apiKeyView);
    },

    async createApiKey(wallet, request) {
      const value = secret(API_KEY_PREFIX);
      const row = await db.apiKey.create({
        data: {
          wallet,
          label: request.label,
          prefix: value.slice(0, DISPLAY_PREFIX_LENGTH),
          secretHash: sha256Hex(value),
          scopes: [...new Set(request.scopes)].map((scope) => SCOPE_TO_DB[scope]),
        },
      });
      return { apiKey: apiKeyView(row), secret: value };
    },

    async revokeApiKey(wallet, id) {
      const revoked = UUID.test(id)
        ? await db.apiKey.updateMany({ where: { id, wallet, revokedAt: null }, data: { revokedAt: new Date(clock()) } })
        : { count: 0 };
      if (revoked.count !== 1) throw notFound('API anahtarı bulunamadı');
    },

    async principal({ bearer, apiKey }) {
      const now = new Date(clock());
      if (bearer !== null) {
        const session = bearer.startsWith(SESSION_PREFIX)
          ? await db.session.findUnique({ where: { tokenHash: sha256Hex(bearer) } })
          : null;
        if (!session || session.revokedAt || session.expiresAt <= now) {
          throw unauthorized('oturum geçersiz ya da süresi dolmuş');
        }
        return { kind: 'session', wallet: session.wallet, sessionId: session.id };
      }
      if (apiKey !== null) {
        const key = apiKey.startsWith(API_KEY_PREFIX)
          ? await db.apiKey.findUnique({ where: { secretHash: sha256Hex(apiKey) } })
          : null;
        if (!key || key.revokedAt) throw unauthorized('API anahtarı geçersiz');
        await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
        return {
          kind: 'apiKey',
          wallet: key.wallet,
          keyId: key.id,
          scopes: key.scopes.map((scope) => SCOPE_FROM_DB[scope]),
        };
      }
      return null;
    },
  };
}
