// İstek sahibi: API'nin oturumu ya da API anahtarı (apps/api, aynı veritabanı). `Authorization: Bearer <oturum>`
// ya da `X-API-Key: <anahtar>`; ikisi birlikte gönderilemez. Anahtar `tx:prepare` kapsamını taşımalıdır:
// sponsorlu imza tx hazırlığının parçasıdır (ADR 0019). Belirteçler veritabanında yalnızca SHA-256'larıyla durur.
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@squaresdk/solana-db';
import type { RequestHandler, Response } from 'express';
import { badRequest, forbidden, unauthorized } from './http.js';

const SESSION_PREFIX = 'sqs_';
const API_KEY_PREFIX = 'sqk_';
const BEARER = /^Bearer (\S+)$/;

export interface Principal {
  readonly wallet: string;
  /** API anahtarıyla gelen istekte anahtarın kimliği; oturumda null. */
  readonly apiKeyId: string | null;
}

export interface Authenticator {
  /** Başlıklardan istek sahibi; kimlik yoksa ya da geçersizse 401, kapsam eksikse 403. */
  principal(credentials: { bearer: string | null; apiKey: string | null }): Promise<Principal>;
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export function createAuthenticator(deps: { db: PrismaClient; clock?: () => number }): Authenticator {
  const { db } = deps;
  const clock = deps.clock ?? Date.now;
  return {
    async principal({ bearer, apiKey }) {
      const now = new Date(clock());
      if (bearer !== null) {
        const session = bearer.startsWith(SESSION_PREFIX)
          ? await db.session.findUnique({ where: { tokenHash: sha256Hex(bearer) } })
          : null;
        if (!session || session.revokedAt || session.expiresAt <= now) {
          throw unauthorized('oturum geçersiz ya da süresi dolmuş');
        }
        return { wallet: session.wallet, apiKeyId: null };
      }
      if (apiKey !== null) {
        const key = apiKey.startsWith(API_KEY_PREFIX)
          ? await db.apiKey.findUnique({ where: { secretHash: sha256Hex(apiKey) } })
          : null;
        if (!key || key.revokedAt) throw unauthorized('API anahtarı geçersiz');
        if (!key.scopes.includes('txPrepare')) throw forbidden('API anahtarının tx:prepare kapsamı yok');
        await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
        return { wallet: key.wallet, apiKeyId: key.id };
      }
      throw unauthorized('oturum ya da API anahtarı gerekli');
    },
  };
}

export const principalOf = (res: Response): Principal => res.locals['principal'] as Principal;

/** İstek sahibini çözer ve `res.locals.principal`'a yazar. */
export function authenticate(auth: Authenticator): RequestHandler {
  return (req, res, next) => {
    const authorization = req.get('authorization') ?? null;
    const apiKey = req.get('x-api-key') ?? null;
    if (authorization !== null && apiKey !== null) {
      next(badRequest('Authorization ve X-API-Key birlikte gönderilemez'));
      return;
    }
    const bearer = authorization === null ? null : (BEARER.exec(authorization)?.[1] ?? '');
    auth.principal({ bearer, apiKey }).then((principal) => {
      res.locals['principal'] = principal;
      next();
    }, next);
  };
}
