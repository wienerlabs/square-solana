// Yazma uçları: teslimat yükleme, agent card barındırma ve A2A keşif yolu, politika meta verisi, tx hazırlama,
// prover vekili. Yetki OpenAPI `security`'sidir (auth/middleware.ts); kaynak üzerindeki yetki servislerdedir.
import type { ReadApi } from '@squaresdk/solana-indexer/read';
import { Address, ProveRequestSchema, TxRequestSchema } from '@squaresdk/solana-types';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { principalOf, requireActor, requireSession } from '../auth/middleware.js';
import type { CardService } from '../cards.js';
import type { DeliveryService } from '../deliveries.js';
import { badRequest, notFound, parse, route, sendOk, unauthorized } from '../http.js';
import type { PolicyMetaService } from '../policy-meta.js';
import type { ProverProxy } from '../prover.js';
import type { TxBuilder } from '../tx.js';
import { readUpload } from '../upload.js';

const CardQuery = z.object({ agentId: z.string().min(1).max(64).optional() }).strict();

const pathAddress = (req: Request, name: string) => parse(Address, req.params[name], name);

export function writeRoutes(deps: {
  deliveries: DeliveryService;
  cards: CardService;
  policyMeta: PolicyMetaService;
  read: ReadApi;
  tx: TxBuilder;
  prover: ProverProxy;
  deliveryMaxBytes: number;
  writeLimit: RequestHandler;
  readLimit: RequestHandler;
}): Router {
  const router = Router();
  const { writeLimit } = deps;

  router.post(
    '/v1/jobs/:job/deliveries',
    writeLimit,
    route(async (req, res) => {
      // Yetki ve yol gövde okunmadan denetlenir: yetkisiz istek dosyayı belleğe almaz.
      const principal = requireActor(res, 'deliveries:write');
      const job = pathAddress(req, 'job');
      const file = await readUpload(req, deps.deliveryMaxBytes);
      // busboy içerik tipini `tip/alt-tip` olarak ayrıştırır, geçersizini `application/octet-stream` yapar.
      const contentType = file.mimeType;
      if (contentType.length > 120) throw badRequest('dosyanın içerik tipi 120 karakteri aşıyor');
      const receipt = await deps.deliveries.upload({
        wallet: principal.wallet,
        job,
        content: file.content,
        contentType,
      });
      sendOk(res, receipt, 201);
    }),
  );

  router.put(
    '/v1/agents/:agentRecord/card',
    writeLimit,
    route(async (req, res) => {
      const principal = requireActor(res, 'agents:write');
      const { agentId } = parse(CardQuery, req.query, 'sorgu');
      const hosting = await deps.cards.put({
        wallet: principal.wallet,
        agentRecord: pathAddress(req, 'agentRecord'),
        agentId: agentId ?? null,
        card: req.body,
      });
      sendOk(res, hosting);
    }),
  );
  router.get(
    '/a/:agentRecord/.well-known/agent-card.json',
    deps.readLimit,
    route(async (req, res) => {
      const raw = await deps.cards.hosted(pathAddress(req, 'agentRecord'));
      if (!raw) throw notFound('barındırılan agent card yok');
      // Sözleşmedeki zarfsız yanıt; baytlar `agentCardHash`'in hesaplandığı baytlardır.
      res.status(200).type('application/json').send(raw);
    }),
  );

  router.put(
    '/v1/policies/:policy/meta',
    writeLimit,
    route(async (req, res) => {
      const { wallet } = requireSession(res);
      const policy = pathAddress(req, 'policy');
      await deps.policyMeta.put({ wallet, policy, meta: req.body });
      sendOk(res, await deps.read.getPolicy(policy));
    }),
  );

  router.post(
    '/v1/tx',
    writeLimit,
    route(async (req, res) => {
      requireActor(res, 'tx:prepare');
      sendOk(res, await deps.tx.prepare(parse(TxRequestSchema, req.body, 'tx isteği')));
    }),
  );

  router.post(
    '/v1/prove',
    writeLimit,
    route(async (req, res) => {
      // OpenAPI: yalnızca API anahtarı (servisler arası); oturum kabul edilmez.
      if (principalOf(res)?.kind !== 'apiKey') throw unauthorized('ispat için prove kapsamlı API anahtarı gerekli');
      requireActor(res, 'prove');
      sendOk(res, await deps.prover.prove(parse(ProveRequestSchema, req.body, 'ispat isteği')));
    }),
  );
  return router;
}
