// Teslimat: çıktının baytlara çevrilmesi, makbuzun yerelde doğrulanması, artefakt parçaları ve API yükleyicisi.
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { createApiClient } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { apiDeliveryUploader, deliveryArtifact, normalizeDeliverable, verifyReceipt } from '../src/delivery.js';
import { API_URL, FakeApi } from './helpers/harness.js';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

describe('normalizeDeliverable', () => {
  it('metin UTF-8 text/plain, nesne içerik tipiyle', () => {
    const text = normalizeDeliverable('ğüş');
    expect(Buffer.from(text.content).toString('utf8')).toBe('ğüş');
    expect(text.contentType).toBe('text/plain; charset=utf-8');
    const bytes = normalizeDeliverable({ content: Uint8Array.of(1, 2, 3), contentType: ' application/octet-stream ' });
    expect(bytes).toEqual({ content: Uint8Array.of(1, 2, 3), contentType: 'application/octet-stream' });
  });

  it('geçersiz çıktıyı reddeder', () => {
    expect(() => normalizeDeliverable(null as never)).toThrow('metin ya da');
    expect(() => normalizeDeliverable({ content: 'x' } as never)).toThrow('metin ya da');
    expect(() => normalizeDeliverable({ content: 'x', contentType: '' })).toThrow('120');
    expect(() => normalizeDeliverable({ content: 'x', contentType: 'a'.repeat(121) })).toThrow('120');
    expect(() => normalizeDeliverable({ content: [1] as never, contentType: 'x/y' })).toThrow('Uint8Array');
  });
});

describe('verifyReceipt ve deliveryArtifact', () => {
  const delivery = normalizeDeliverable({ content: '{"a":1}', contentType: 'application/json' });
  const receipt = {
    workHash: sha(delivery.content),
    deliveryUri: 'ipfs://bafy-teslimat',
    contentType: 'application/json',
    size: delivery.content.length,
  };

  it('makbuz içerikle eşleşmeli', () => {
    expect(verifyReceipt(receipt, delivery)).toEqual(receipt);
    expect(() => verifyReceipt({ ...receipt, workHash: 'zz' }, delivery)).toThrow('makbuzu geçersiz');
    expect(() => verifyReceipt({ ...receipt, workHash: '00'.repeat(32) }, delivery)).toThrow('eşleşmiyor');
  });

  it('metin içerik satır içi, ipfs adresi url parçası', () => {
    const artifact = deliveryArtifact(delivery, receipt);
    expect(artifact.artifactId).toBe('delivery');
    expect(artifact.parts.map((p) => Object.keys(p).find((k) => ['data', 'url', 'text'].includes(k)))).toEqual([
      'data',
      'url',
      'text',
    ]);
  });

  it('ikili içerik ve URL olmayan adres yalnızca makbuzla verilir', () => {
    const binary = normalizeDeliverable({ content: Uint8Array.of(0xff, 0xfe), contentType: 'application/json' });
    const artifact = deliveryArtifact(binary, { ...receipt, deliveryUri: 's3-anahtar/teslimat' });
    expect(artifact.parts).toHaveLength(1);
    expect(artifact.parts[0]!.data).toMatchObject({ deliveryUri: 's3-anahtar/teslimat' });
    const image = normalizeDeliverable({ content: Uint8Array.of(1), contentType: 'image/png' });
    expect(deliveryArtifact(image, receipt).parts).toHaveLength(2);
  });
});

describe('apiDeliveryUploader', () => {
  it('teslimatı multipart olarak yükler, hata zarfını fırlatır', async () => {
    const fake = new FakeApi();
    const uploader = apiDeliveryUploader(
      createApiClient({ baseUrl: API_URL, auth: { apiKey: 'k' }, fetch: fake.fetch }),
    );
    const job = Keypair.generate().publicKey;
    const receipt = await uploader.upload({
      job,
      content: Uint8Array.of(7, 8),
      contentType: 'application/octet-stream',
    });
    expect(receipt.workHash).toBe(sha(Uint8Array.of(7, 8)));
    expect(fake.uploads[0]).toMatchObject({ job: job.toBase58(), contentType: 'application/octet-stream' });
    fake.uploadStatus = 403;
    await expect(uploader.upload({ job, content: Uint8Array.of(1), contentType: 'text/plain' })).rejects.toThrow(
      'teslimat yüklenemedi: forbidden yetki yok',
    );
  });
});
