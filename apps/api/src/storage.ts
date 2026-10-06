// Teslimat deposu: S3 uyumlu nesne deposu (AWS S3, Cloudflare R2, MinIO …); sağlayıcı ve uç nokta ortamdan
// gelir. Covenant'ın teslimat akışındaki gibi (Vercel Blob) içerik deposunun herkese açık adresiyle okunur:
// `deliveryUri` = `<API_DELIVERY_PUBLIC_BASE_URL>/<workHash>`. Anahtar içeriğin SHA-256'sıdır; aynı içerik tek
// nesnedir ve adres içeriği doğrular. Kova, nesnelerin herkese açık okunmasına dağıtımda ayarlanır.
import { HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DeliveryStoreConfig } from './config.js';

export interface DeliveryStore {
  /** İçeriği `workHash` anahtarıyla yazar; herkese açık adresi döner. */
  put(workHash: string, content: Buffer, contentType: string): Promise<{ key: string; uri: string }>;
  /** Kova erişilebilir mi (hazırlık denetimi). */
  check(): Promise<void>;
}

export function createDeliveryStore(config: DeliveryStoreConfig): DeliveryStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async put(workHash, content, contentType) {
      if (!/^[0-9a-f]{64}$/.test(workHash)) throw new Error('workHash 64 hex olmalı');
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: workHash, Body: content, ContentType: contentType }),
      );
      return { key: workHash, uri: `${config.publicBaseUrl}/${workHash}` };
    },
    async check() {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    },
  };
}
