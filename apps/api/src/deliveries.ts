// Teslimat yükleme (`uploadDelivery`): içerik depoya yazılır, `submit_work`'ün argümanları döner. `workHash`
// içeriğin SHA-256'sıdır (SDK `workHash`), `deliveryUri` deponun herkese açık adresi. Yükleyen job'un agent
// cüzdanı (`submit_work`'ü imzalayan) ya da agent kaydının sahibidir. Aynı job'a aynı içerik ikinci kez
// yüklenirse aynı makbuz döner.
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@squaresdk/solana-db';
import type { DeliveryReceipt } from '@squaresdk/solana-types';
import { forbidden, notFound } from './http.js';
import type { DeliveryStore } from './storage.js';

export interface DeliveryService {
  upload(params: { wallet: string; job: string; content: Buffer; contentType: string }): Promise<DeliveryReceipt>;
}

export function createDeliveryService(deps: { db: PrismaClient; store: DeliveryStore }): DeliveryService {
  const { db, store } = deps;
  return {
    async upload({ wallet, job, content, contentType }) {
      const row = await db.job.findFirst({ where: { address: job, closedSlot: null } });
      if (!row) throw notFound('job bulunamadı');
      const agent = await db.agent.findUnique({ where: { address: row.agentRecord }, select: { owner: true } });
      if (wallet !== row.agentWallet && wallet !== agent?.owner) {
        throw forbidden('teslimatı yalnızca job’un agent cüzdanı ya da agent sahibi yükleyebilir');
      }
      const workHash = createHash('sha256').update(content).digest('hex');
      const { key, uri } = await store.put(workHash, content, contentType);
      const data = {
        deliveryUri: uri,
        contentType,
        byteSize: BigInt(content.length),
        storageKey: key,
        uploadedBy: wallet,
      };
      await db.delivery.upsert({
        where: { job_workHash: { job, workHash } },
        create: { job, workHash, ...data },
        update: data,
      });
      return { workHash, deliveryUri: uri, contentType, size: content.length };
    },
  };
}
