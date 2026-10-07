// Uyuşmazlık uçları (BE-22): dispute kanıtı, arbitrator kuyruğu ve oyu, webhook abonelikleri. Yetki OpenAPI
// `security`'sidir; kaynak üzerindeki yetki (taraf, aktif arbitrator) servislerdedir.
import { Address, DisputeVoteRequestSchema, PageQuerySchema } from '@squaresdk/solana-types';
import { Router, type Request, type RequestHandler } from 'express';
import { requireActor, requireSession } from '../auth/middleware.js';
import type { ArbitrationService } from '../disputes/arbitration.js';
import type { EvidenceService } from '../disputes/evidence.js';
import type { WebhookService } from '../disputes/webhooks.js';
import { badRequest, parse, route, sendOk, sendPage } from '../http.js';
import { readUpload } from '../upload.js';

const pathAddress = (req: Request, name: string) => parse(Address, req.params[name], name);
const QueueQuery = PageQuerySchema.strict();

export function disputeRoutes(deps: {
  evidence: EvidenceService;
  arbitration: ArbitrationService;
  webhooks: WebhookService;
  evidenceMaxBytes: number;
  writeLimit: RequestHandler;
  readLimit: RequestHandler;
}): Router {
  const router = Router();
  const { writeLimit, readLimit } = deps;

  router.post(
    '/v1/jobs/:job/dispute/evidence',
    writeLimit,
    route(async (req, res) => {
      // Yetki ve yol gövde okunmadan denetlenir: yetkisiz istek dosyayı belleğe almaz.
      const principal = requireActor(res, 'disputes:write');
      const job = pathAddress(req, 'job');
      const file = await readUpload(req, deps.evidenceMaxBytes);
      if (file.mimeType.length > 120) throw badRequest('dosyanın içerik tipi 120 karakteri aşıyor');
      sendOk(
        res,
        await deps.evidence.upload({
          wallet: principal.wallet,
          job,
          content: file.content,
          contentType: file.mimeType,
        }),
        201,
      );
    }),
  );

  router.get(
    '/v1/disputes/:job/evidence',
    readLimit,
    route(async (req, res) => {
      const principal = requireActor(res, 'disputes:read');
      sendOk(res, await deps.evidence.list({ wallet: principal.wallet, job: pathAddress(req, 'job') }));
    }),
  );

  router.get(
    '/v1/disputes/:job/evidence/:id',
    readLimit,
    route(async (req, res) => {
      const principal = requireActor(res, 'disputes:read');
      const { contentType, content } = await deps.evidence.content({
        wallet: principal.wallet,
        job: pathAddress(req, 'job'),
        id: String(req.params['id']),
      });
      // Kanıt tarayıcıda çalıştırılmaz: indirme olarak ve tipi koklanmadan verilir.
      res
        .status(200)
        .type(contentType)
        .set('content-disposition', 'attachment')
        .set('cache-control', 'private, no-store')
        .send(content);
    }),
  );

  router.post(
    '/v1/disputes/:job/votes',
    writeLimit,
    route(async (req, res) => {
      const principal = requireActor(res, 'tx:prepare');
      const request = parse(DisputeVoteRequestSchema, req.body, 'oy isteği');
      sendOk(
        res,
        await deps.arbitration.prepareVote({ wallet: principal.wallet, job: pathAddress(req, 'job'), request }),
      );
    }),
  );

  router.get(
    '/v1/arbitration/queue',
    readLimit,
    route(async (req, res) => {
      const principal = requireActor(res, 'disputes:read');
      const page = parse(QueueQuery, req.query, 'sorgu');
      sendPage(res, await deps.arbitration.queue(principal.wallet, page));
    }),
  );

  router.get(
    '/v1/arbitration/webhooks',
    readLimit,
    route(async (_req, res) => {
      const { wallet } = requireSession(res);
      sendOk(res, await deps.webhooks.list(wallet));
    }),
  );

  router.post(
    '/v1/arbitration/webhooks',
    writeLimit,
    route(async (req, res) => {
      const { wallet } = requireSession(res);
      sendOk(res, await deps.webhooks.create(wallet, req.body), 201);
    }),
  );

  router.delete(
    '/v1/arbitration/webhooks/:id',
    writeLimit,
    route(async (req, res) => {
      const { wallet } = requireSession(res);
      await deps.webhooks.remove(wallet, String(req.params['id']));
      res.status(204).end();
    }),
  );
  return router;
}
