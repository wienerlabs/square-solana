// Servisin OpenAPI 3.1 belgesi (`GET /openapi.json`). Gövde şemaları @squaresdk/solana-types'taki zod
// şemalarından üretilir; API sözleşmesindeki `POST /v1/prove` ile aynı istek, yanıt ve zarftır.
import { HealthSchema, ProveRequestSchema, ProveResponseSchema, envelopeSchema } from '@squaresdk/solana-types';
import { z } from 'zod';

const ProveEnvelopeSchema = envelopeSchema(ProveResponseSchema);

const json = (schema: z.ZodType) => ({ 'application/json': { schema: z.toJSONSchema(schema, { io: 'input' }) } });
const envelope = (description: string) => ({ description, content: json(ProveEnvelopeSchema) });

export function openapiDocument(info: { name: string; version: string; artifactVersion: string }) {
  return {
    openapi: '3.1.0',
    info: {
      title: info.name,
      version: info.version,
      description:
        'Square release devresi (circuits/payment-compliance) için Groth16 prover. Çıktı groth16-solana ' +
        `bayt düzenindedir. Yüklü artefakt sürümü (zkey SHA-256): ${info.artifactVersion}.\n\n` +
        '**Güven sınırı:** witness politikanın kendisidir; bu servisi işleten taraf politikayı görür. ' +
        "Kurum ya kendi prover'ını çalıştırır ya da @squaresdk/solana-policy ile in-process ispat üretir. " +
        "Servis witness'ı saklamaz ve log'a yazmaz.",
    },
    components: {
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
    },
    paths: {
      '/v1/prove': {
        post: {
          operationId: 'prove',
          summary: 'Release devresi için Groth16 ispatı',
          security: [{ apiKey: [] }],
          requestBody: { required: true, content: json(ProveRequestSchema) },
          responses: {
            '200': envelope('İspat ve 13 public sinyal'),
            '400': envelope('Geçersiz istek ya da devreyi sağlamayan witness (`invalid_input`)'),
            '401': envelope('API anahtarı yok ya da geçersiz (`unauthorized`)'),
            '409': envelope('`artifactVersion` yüklü zkey ile uyuşmuyor (`conflict`)'),
            '500': envelope('Beklenmeyen hata (`internal_error`)'),
            '503': envelope('Kapasite dolu (`prover_unavailable`); `Retry-After` başlığına uyun'),
          },
        },
      },
      '/health': {
        get: {
          operationId: 'getHealth',
          summary: 'Süreç sağlığı (zarfsız)',
          responses: { '200': { description: 'Çalışıyor', content: json(HealthSchema) } },
        },
      },
      '/ready': {
        get: {
          operationId: 'getReady',
          summary: 'İstek kabul edebilir mi: artefaktlar yüklü, kapasite var (zarfsız)',
          responses: {
            '200': { description: 'Hazır', content: json(HealthSchema) },
            '503': { description: 'Kapasite dolu', content: json(HealthSchema) },
          },
        },
      },
    },
  };
}
