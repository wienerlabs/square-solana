import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DELIVERY_URI_MAX_BYTES, DeliveryUploadError, type DeliveryUploader } from '@squaresdk/solana-agent-sdk';
import type { DeliveryReceipt } from '@squaresdk/solana-types';

export const DELIVERIES_PATH = '/deliveries';

export interface StoredDelivery {
  content: Uint8Array;
  contentType: string;
}

export interface DeliveryStore extends DeliveryUploader {
  get(workHash: string): StoredDelivery | null;
  handle(request: IncomingMessage, response: ServerResponse): boolean;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function basePathOf(publicUrl: string): string {
  return new URL(publicUrl).pathname.replace(/\/+$/, '');
}

export function createDeliveryStore(publicUrl: string): DeliveryStore {
  const url = new URL(publicUrl);
  const basePath = basePathOf(publicUrl);
  const origin = `${url.origin}${basePath}`;
  const route = new RegExp(`^${escapeRegExp(basePath)}${DELIVERIES_PATH}/([0-9a-f]{64})$`);
  const items = new Map<string, StoredDelivery>();

  return {
    async upload({ content, contentType }): Promise<DeliveryReceipt> {
      const workHash = createHash('sha256').update(content).digest('hex');
      const deliveryUri = `${origin}${DELIVERIES_PATH}/${workHash}`;
      if (Buffer.byteLength(deliveryUri, 'utf8') > DELIVERY_URI_MAX_BYTES) {
        throw new DeliveryUploadError(`teslimat adresi ${DELIVERY_URI_MAX_BYTES} baytı aşıyor: ${deliveryUri}`, false);
      }
      items.set(workHash, { content: Uint8Array.from(content), contentType });
      return { workHash, deliveryUri, contentType, size: content.byteLength };
    },

    get(workHash) {
      return items.get(workHash) ?? null;
    },

    handle(request, response) {
      const match = route.exec(new URL(request.url ?? '/', 'http://agent.invalid').pathname);
      if (!match) return false;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return true;
      }
      const item = items.get(match[1]!);
      if (!item) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'teslimat yok' }));
        return true;
      }
      response.writeHead(200, {
        'content-type': item.contentType,
        'content-length': item.content.byteLength,
        'cache-control': 'public, max-age=31536000, immutable',
        etag: `"${match[1]}"`,
      });
      response.end(request.method === 'HEAD' ? undefined : Buffer.from(item.content));
      return true;
    },
  };
}
