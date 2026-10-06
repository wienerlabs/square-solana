// Test fixture: Square API'sinin teslimat yükleme ucunu taklit eden fetch (packages/agent-sdk/test/helpers/harness.ts
// FakeApi'nin teslimat kısmı). Makbuz içeriğin SHA-256'sıdır.
import { createHash } from 'node:crypto';
import { createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import type { DeliveryReceipt } from '@squaresdk/solana-types';

export const API_URL = 'https://api.square.test';

export interface Upload {
  job: string;
  content: Uint8Array;
  contentType: string;
  receipt: DeliveryReceipt;
}

export class FakeApi {
  readonly uploads: Upload[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const envelope = (status: number, data: unknown, error: unknown = null) =>
      new Response(JSON.stringify({ success: status < 400, data, error, meta: { requestId: 'test' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const delivery = /^\/v1\/jobs\/([^/]+)\/deliveries$/.exec(url.pathname);
    if (delivery && init?.method === 'POST') {
      const file = (init.body as FormData).get('file') as Blob;
      const content = new Uint8Array(await file.arrayBuffer());
      const workHash = createHash('sha256').update(content).digest('hex');
      const receipt: DeliveryReceipt = {
        workHash,
        deliveryUri: `https://cdn.square.test/d/${workHash.slice(0, 32)}`,
        contentType: file.type,
        size: content.length,
      };
      this.uploads.push({ job: decodeURIComponent(delivery[1]!), content, contentType: file.type, receipt });
      return envelope(201, receipt);
    }
    return envelope(404, null, { code: 'not_found', message: url.pathname, programError: null, details: null });
  };

  client(): SquareApi {
    return createApiClient({ baseUrl: API_URL, auth: { apiKey: 'sqk_test' }, fetch: this.fetch });
  }
}
