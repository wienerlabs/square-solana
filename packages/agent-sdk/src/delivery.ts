// Teslimat: işleyicinin çıktısı baytlara çevrilir, depoya yüklenir (varsayılan Square API'si,
// `POST /v1/jobs/{job}/deliveries`) ve makbuz yerelde doğrulanır: `workHash` içeriğin SHA-256'sı olmalı,
// `deliveryUri` `submit_work`'ün 128 bayt sınırına sığmalı. Depoya körü körüne güvenilmez; zincire giden
// taahhüt agent'ın kendi hesapladığı hash'tir.
import type { PublicKey } from '@solana/web3.js';
import { workHash, type SquareApi } from '@squaresdk/solana-sdk';
import { DeliveryReceiptSchema, type Artifact, type DeliveryReceipt, type Part } from '@squaresdk/solana-types';
import type { Deliverable, DeliveryUploader } from './types.js';

/** `submit_work`'ün `delivery_uri` sınırı (escrow `DELIVERY_URI_MAX_LEN`). */
export const DELIVERY_URI_MAX_BYTES = 128;
/** Artefakta metin olarak da eklenen teslimatın en büyük boyutu. */
const INLINE_TEXT_MAX_BYTES = 16 * 1024;

export interface NormalizedDelivery {
  content: Uint8Array;
  contentType: string;
}

export function normalizeDeliverable(output: Deliverable): NormalizedDelivery {
  if (typeof output === 'string') {
    return { content: new TextEncoder().encode(output), contentType: 'text/plain; charset=utf-8' };
  }
  if (output === null || typeof output !== 'object' || typeof output.contentType !== 'string') {
    throw new Error('işleyici metin ya da { content, contentType } döndürmeli');
  }
  const contentType = output.contentType.trim();
  if (contentType.length === 0 || contentType.length > 120) throw new Error('contentType 1 ile 120 karakter olmalı');
  const content = typeof output.content === 'string' ? new TextEncoder().encode(output.content) : output.content;
  if (!(content instanceof Uint8Array)) throw new Error('content metin ya da Uint8Array olmalı');
  return { content, contentType };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Makbuzu içerikle karşılaştırır; uymayan makbuz teslim edilmez. */
export function verifyReceipt(receipt: DeliveryReceipt, delivery: NormalizedDelivery): DeliveryReceipt {
  const parsed = DeliveryReceiptSchema.safeParse(receipt);
  if (!parsed.success) throw new Error('teslimat makbuzu geçersiz');
  const expected = hex(workHash(delivery.content));
  if (parsed.data.workHash !== expected) {
    throw new Error(`teslimat makbuzunun workHash'i içerikle eşleşmiyor: ${parsed.data.workHash} ≠ ${expected}`);
  }
  if (Buffer.byteLength(parsed.data.deliveryUri, 'utf8') > DELIVERY_URI_MAX_BYTES) {
    throw new Error(`deliveryUri ${DELIVERY_URI_MAX_BYTES} baytı aşıyor`);
  }
  return parsed.data;
}

export class DeliveryUploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DeliveryUploadError';
  }
}

const RETRYABLE_UPLOAD_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'rpc_unavailable',
  'db_unavailable',
  'internal_error',
]);

/** Square API'si üzerinden yükleyici (`deliveries:write` kapsamlı oturum ya da API anahtarı). */
export function apiDeliveryUploader(api: SquareApi): DeliveryUploader {
  return {
    async upload({ job, content, contentType }: { job: PublicKey; content: Uint8Array; contentType: string }) {
      const body = new Uint8Array(content.byteLength);
      body.set(content);
      const envelope = await api.uploadDelivery(job.toBase58(), new Blob([body], { type: contentType }));
      if (!envelope.success || !envelope.data) {
        const code = envelope.error?.code ?? 'bilinmiyor';
        throw new DeliveryUploadError(
          `teslimat yüklenemedi: ${code} ${envelope.error?.message ?? ''}`,
          RETRYABLE_UPLOAD_CODES.has(code),
        );
      }
      return envelope.data;
    },
  };
}

const isText = (contentType: string) => /^(text\/|application\/(json|xml|[a-z.+-]*\+json))/i.test(contentType);

/** Görevin teslimat artefaktı: makbuz (`data`), adres (`url`, A2A şemasına uyuyorsa) ve kısa metin içerik. */
export function deliveryArtifact(delivery: NormalizedDelivery, receipt: DeliveryReceipt): Artifact {
  const parts: Part[] = [
    {
      data: {
        workHash: receipt.workHash,
        deliveryUri: receipt.deliveryUri,
        contentType: receipt.contentType,
        size: receipt.size,
      },
      mediaType: 'application/json',
      metadata: { square: { kind: 'deliveryReceipt' } },
    },
  ];
  if (/^(https?|ipfs):\/\//i.test(receipt.deliveryUri)) {
    parts.push({ url: receipt.deliveryUri, mediaType: delivery.contentType });
  }
  if (isText(delivery.contentType) && delivery.content.byteLength <= INLINE_TEXT_MAX_BYTES) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(delivery.content);
      if (!text.includes('\u0000')) parts.push({ text, mediaType: delivery.contentType });
    } catch {
      // UTF-8 olmayan içerik yalnızca adresiyle verilir.
    }
  }
  return { artifactId: 'delivery', name: 'Teslimat', parts };
}
