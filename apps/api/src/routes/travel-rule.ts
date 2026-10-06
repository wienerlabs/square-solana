// Travel Rule uçları (BE-23): kayıt yazma ve okuma, okuma izni ve erişim kaydı. Kişisel veriye dokunan uçlar
// yalnızca cüzdan oturumuyla çağrılır (API anahtarı kabul edilmez); kaynak üzerindeki yetki servistedir. Kurum bir
// smart account'un vault'uyla açıldıysa üye `X-Square-Smart-Account` başlığını verir (caller.ts).
import { Address, PageQuerySchema } from '@squaresdk/solana-types';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireSession } from '../auth/middleware.js';
import { callerOf } from '../caller.js';
import { parse, requestIdOf, route, sendOk, sendPage } from '../http.js';
import type { TravelRuleActor, TravelRuleService } from '../travel-rule/service.js';

const pathAddress = (req: Request, name: string) => parse(Address, req.params[name], name);
const AccessQuery = PageQuerySchema.strict();

const actorOf = (res: Response): TravelRuleActor => ({
  ...callerOf(res, requireSession(res)),
  requestId: requestIdOf(res),
});

export function travelRuleRoutes(deps: {
  travelRule: TravelRuleService;
  readLimit: RequestHandler;
  writeLimit: RequestHandler;
}): Router {
  const router = Router();
  const { travelRule, readLimit, writeLimit } = deps;
  const base = '/v1/jobs/:job/travel-rule';

  router.put(
    base,
    writeLimit,
    route(async (req, res) => {
      sendOk(res, await travelRule.put(actorOf(res), pathAddress(req, 'job'), req.body));
    }),
  );
  router.get(
    base,
    readLimit,
    route(async (req, res) => {
      sendOk(res, await travelRule.disclose(actorOf(res), pathAddress(req, 'job')));
    }),
  );
  router.post(
    `${base}/grants`,
    writeLimit,
    route(async (req, res) => {
      sendOk(res, await travelRule.grant(actorOf(res), pathAddress(req, 'job'), req.body), 201);
    }),
  );
  router.delete(
    `${base}/grants/:grantee`,
    writeLimit,
    route(async (req, res) => {
      await travelRule.revoke(actorOf(res), pathAddress(req, 'job'), pathAddress(req, 'grantee'));
      res.status(204).end();
    }),
  );
  router.get(
    `${base}/access`,
    readLimit,
    route(async (req, res) => {
      const page = parse(AccessQuery, req.query, 'sorgu');
      sendPage(res, await travelRule.listAccess(actorOf(res), pathAddress(req, 'job'), page));
    }),
  );
  return router;
}
