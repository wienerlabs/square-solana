// x402 etiketi: ücretli uç nokta tanımları ve kullanımı (FE-22). Tanımı oluşturan, değiştiren ve silen oturumdur
// (geliştirici portalı). Geliştiricinin sunucusu `x402:serve` kapsamlı anahtarla tanımı okur, kullanımı görür ve
// uzlaştırdığı ödemeyi bildirir; oturum da bunları yapabilir.
import { X402EndpointCreateSchema, X402EndpointUpdateSchema, X402PaymentReportSchema } from '@squaresdk/solana-types';
import { Router, type RequestHandler, type Response } from 'express';
import { requireActor, requireSession } from '../auth/middleware.js';
import { parse, route, sendOk } from '../http.js';
import type { X402EndpointService } from '../x402.js';

const serving = (res: Response) => requireActor(res, 'x402:serve').wallet;

export function x402Routes(deps: {
  x402: X402EndpointService;
  readLimit: RequestHandler;
  writeLimit: RequestHandler;
}): Router {
  const { x402, readLimit, writeLimit } = deps;
  const router = Router();
  const id = (params: Record<string, unknown>) => String(params['id']);

  router.get(
    '/v1/x402/endpoints',
    readLimit,
    route(async (_req, res) => {
      sendOk(res, await x402.list(serving(res)));
    }),
  );
  router.post(
    '/v1/x402/endpoints',
    writeLimit,
    route(async (req, res) => {
      const { wallet } = requireSession(res);
      sendOk(res, await x402.create(wallet, parse(X402EndpointCreateSchema, req.body, 'istek')), 201);
    }),
  );
  router.get(
    '/v1/x402/endpoints/:id',
    readLimit,
    route(async (req, res) => {
      sendOk(res, await x402.get(serving(res), id(req.params)));
    }),
  );
  router.patch(
    '/v1/x402/endpoints/:id',
    writeLimit,
    route(async (req, res) => {
      const { wallet } = requireSession(res);
      sendOk(res, await x402.update(wallet, id(req.params), parse(X402EndpointUpdateSchema, req.body, 'istek')));
    }),
  );
  router.delete(
    '/v1/x402/endpoints/:id',
    writeLimit,
    route(async (req, res) => {
      await x402.remove(requireSession(res).wallet, id(req.params));
      res.status(204).end();
    }),
  );
  router.get(
    '/v1/x402/endpoints/:id/usage',
    readLimit,
    route(async (req, res) => {
      sendOk(res, await x402.usage(serving(res), id(req.params)));
    }),
  );
  router.post(
    '/v1/x402/endpoints/:id/payments',
    writeLimit,
    route(async (req, res) => {
      const wallet = serving(res);
      const report = parse(X402PaymentReportSchema, req.body, 'istek');
      const { payment, created } = await x402.recordPayment(wallet, id(req.params), report);
      sendOk(res, payment, created ? 201 : 200);
    }),
  );
  return router;
}
