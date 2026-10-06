// İstek sahibi ve yetki (OpenAPI `security`): `Authorization: Bearer <oturum>` ya da `X-API-Key: <anahtar>`.
// Verilen kimlik geçersizse herkese açık uçlarda da 401 döner. İkisi birlikte gönderilemez.
// - `requireSession`: yalnızca oturum (anahtar yönetimi, oturum kapatma, politika meta verisi).
// - `requireActor(scope)`: oturum ya da kapsamı (`scope`) olan anahtar.
// - Okuma uçları herkese açıktır; anahtarla gelen okuma `read` kapsamı ister.
import type { ApiKeyScope } from '@squaresdk/solana-types';
import type { RequestHandler, Response } from 'express';
import { badRequest, forbidden, unauthorized } from '../http.js';
import type { AuthService, Principal } from './service.js';

const BEARER = /^Bearer (\S+)$/;

export const principalOf = (res: Response): Principal | null => (res.locals['principal'] as Principal | null) ?? null;

/** İstek sahibini çözer ve `res.locals.principal`'a yazar. */
export function authenticate(auth: AuthService): RequestHandler {
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

export function requireSession(res: Response): Extract<Principal, { kind: 'session' }> {
  const principal = principalOf(res);
  if (principal?.kind !== 'session') throw unauthorized('oturum gerekli');
  return principal;
}

export function requireActor(res: Response, scope: ApiKeyScope): Principal {
  const principal = principalOf(res);
  if (!principal) throw unauthorized('oturum ya da API anahtarı gerekli');
  if (principal.kind === 'apiKey' && !principal.scopes.includes(scope)) {
    throw forbidden(`API anahtarının ${scope} kapsamı yok`);
  }
  return principal;
}

/** Okuma uçları: anahtarla gelen istek `read` kapsamı ister. */
export const requireReadScope: RequestHandler = (_req, res, next) => {
  const principal = principalOf(res);
  if (principal?.kind === 'apiKey' && !principal.scopes.includes('read')) {
    next(forbidden('API anahtarının read kapsamı yok'));
    return;
  }
  next();
};
