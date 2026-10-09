import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { DeliveryUploadError } from '@squaresdk/solana-agent-sdk';
import { describe, expect, it } from 'vitest';
import { basePathOf, createDeliveryStore } from '../src/delivery.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const job = Keypair.generate().publicKey;
const content = new TextEncoder().encode('{"rapor":1}');

function exchange(url: string, method = 'GET') {
  const sent: { status?: number; headers?: Record<string, unknown>; body?: unknown } = {};
  const response = {
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      sent.status = status;
      sent.headers = headers;
      return response;
    },
    end(body?: unknown) {
      sent.body = body;
    },
  } as unknown as ServerResponse;
  return { request: { url, method } as IncomingMessage, response, sent };
}

describe('createDeliveryStore', () => {
  it("içeriği hash'iyle saklar; makbuz public adresin altındaki teslimat yolunu verir", async () => {
    const store = createDeliveryStore('https://agent.example.org/demo/');
    const receipt = await store.upload({ job, content, contentType: 'application/json' });
    expect(receipt).toEqual({
      workHash: sha(content),
      deliveryUri: `https://agent.example.org/demo/deliveries/${sha(content)}`,
      contentType: 'application/json',
      size: content.byteLength,
    });
    expect(store.get(receipt.workHash)?.content).toEqual(content);
    expect(store.get('00'.repeat(32))).toBeNull();
  });

  it('teslimatı GET ve HEAD ile sunar; başka yöntem 405, bilinmeyen hash 404, başka yol işlenmez', async () => {
    const store = createDeliveryStore('https://agent.example.org/demo');
    const { workHash } = await store.upload({ job, content, contentType: 'application/json' });

    const get = exchange(`/demo/deliveries/${workHash}`);
    expect(store.handle(get.request, get.response)).toBe(true);
    expect(get.sent.status).toBe(200);
    expect(get.sent.headers).toMatchObject({ 'content-type': 'application/json', etag: `"${workHash}"` });
    expect(sha(new Uint8Array(get.sent.body as Buffer))).toBe(workHash);

    const head = exchange(`/demo/deliveries/${workHash}`, 'HEAD');
    expect(store.handle(head.request, head.response)).toBe(true);
    expect(head.sent.body).toBeUndefined();

    const post = exchange(`/demo/deliveries/${workHash}`, 'POST');
    expect(store.handle(post.request, post.response)).toBe(true);
    expect(post.sent.status).toBe(405);

    const missing = exchange(`/demo/deliveries/${'0'.repeat(64)}`);
    expect(store.handle(missing.request, missing.response)).toBe(true);
    expect(missing.sent.status).toBe(404);

    for (const path of ['/deliveries/x', `/deliveries/${workHash}`, '/demo/a2a', '/demo/deliveries/']) {
      const other = exchange(path);
      expect(store.handle(other.request, other.response)).toBe(false);
      expect(other.sent.status).toBeUndefined();
    }
  });

  it('teslimat adresi 128 baytı aşarsa yükleme kalıcı hatayla reddedilir', async () => {
    const store = createDeliveryStore(`https://agent.example.org/${'a'.repeat(60)}`);
    const upload = store.upload({ job, content, contentType: 'application/json' });
    await expect(upload).rejects.toBeInstanceOf(DeliveryUploadError);
    await expect(upload).rejects.toMatchObject({ retryable: false });
  });

  it('yol öneki sondaki eğik çizgiler atılarak bulunur', () => {
    expect(basePathOf('https://agent.example.org')).toBe('');
    expect(basePathOf('https://agent.example.org/a/b//')).toBe('/a/b');
  });
});
