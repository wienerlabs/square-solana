// auth etiketi: challenge, oturum, API anahtarları.
import { ApiKeyCreateSchema, AuthChallengeRequestSchema, SessionRequestSchema } from '@squaresdk/solana-types';
import { Router, type RequestHandler } from 'express';
import { requireSession } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import { parse, route, sendOk } from '../http.js';

export function authRoutes(deps: { auth: AuthService; readLimit: RequestHandler; writeLimit: RequestHandler }): Router {
  const { auth, readLimit, writeLimit } = deps;
  const router = Router();

  router.post(
    '/v1/auth/challenge',
    writeLimit,
    route(async (req, res) => {
      const body = parse(AuthChallengeRequestSchema, req.body, 'istek');
      sendOk(res, await auth.createChallenge(body.wallet));
    }),
  );
  router.post(
    '/v1/auth/session',
    writeLimit,
    route(async (req, res) => {
      sendOk(res, await auth.createSession(parse(SessionRequestSchema, req.body, 'istek')));
    }),
  );
  router.delete(
    '/v1/auth/session',
    writeLimit,
    route(async (_req, res) => {
      await auth.revokeSession(requireSession(res).sessionId);
      res.status(204).end();
    }),
  );
  router.get(
    '/v1/api-keys',
    readLimit,
    route(async (_req, res) => {
      sendOk(res, await auth.listApiKeys(requireSession(res).wallet));
    }),
  );
  router.post(
    '/v1/api-keys',
    writeLimit,
    route(async (req, res) => {
      const { wallet } = requireSession(res);
      sendOk(res, await auth.createApiKey(wallet, parse(ApiKeyCreateSchema, req.body, 'istek')), 201);
    }),
  );
  router.delete(
    '/v1/api-keys/:id',
    writeLimit,
    route(async (req, res) => {
      await auth.revokeApiKey(requireSession(res).wallet, String(req.params['id']));
      res.status(204).end();
    }),
  );
  return router;
}
