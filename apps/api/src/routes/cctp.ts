// CCTP uçları (BE-26). Kayıt ve tx hazırlığı oturum ya da `tx:prepare` kapsamlı anahtarla, job'un kurumu adına;
// okuma herkese açıktır (mesaj ve attestation Circle'ın servisinde de açıktır), anahtarla gelen istek `read` ister.
import {
  CctpFundTxRequestSchema,
  CctpTransferCreateSchema,
  CctpTransferQuerySchema,
  PageQuerySchema,
} from '@squaresdk/solana-types';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireActor, requireReadScope } from '../auth/middleware.js';
import type { CctpService } from '../cctp.js';
import { parse, route, sendOk, sendPage } from '../http.js';

const TransferQuery = PageQuerySchema.extend(CctpTransferQuerySchema.shape).strict();
const transferId = (req: Request) => parse(z.string().uuid(), req.params['transfer'], 'transfer');

export function cctpRoutes(deps: { cctp: CctpService; readLimit: RequestHandler; writeLimit: RequestHandler }): Router {
  const router = Router();
  const { cctp, readLimit, writeLimit } = deps;

  router.post(
    '/v1/cctp/transfers',
    writeLimit,
    route(async (req, res) => {
      const { wallet } = requireActor(res, 'tx:prepare');
      const request = parse(CctpTransferCreateSchema, req.body, 'CCTP kaydı');
      const { transfer, created } = await cctp.register(wallet, request);
      sendOk(res, transfer, created ? 201 : 200);
    }),
  );
  router.get(
    '/v1/cctp/transfers',
    readLimit,
    requireReadScope,
    route(async (req, res) => {
      const { page, limit, ...filter } = parse(TransferQuery, req.query, 'sorgu');
      sendPage(res, await cctp.list(filter, { page, limit }));
    }),
  );
  router.get(
    '/v1/cctp/transfers/:transfer',
    readLimit,
    requireReadScope,
    route(async (req, res) => {
      sendOk(res, await cctp.get(transferId(req)));
    }),
  );
  router.post(
    '/v1/cctp/transfers/:transfer/tx',
    writeLimit,
    route(async (req, res) => {
      const { wallet } = requireActor(res, 'tx:prepare');
      const id = transferId(req);
      sendOk(res, await cctp.prepare(wallet, id, parse(CctpFundTxRequestSchema, req.body, 'tx isteği')));
    }),
  );
  return router;
}
