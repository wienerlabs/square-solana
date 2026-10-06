// Servisin OpenAPI 3.1 belgesi (`GET /openapi.json`). Gövde şemaları schemas.ts'teki zod şemalarından
// üretilir; zarf ve sayfalama API sözleşmesininkidir (prover'ın belgesiyle aynı yöntem).
import { HealthSchema } from '@squaresdk/solana-types';
import { z } from 'zod';
import { ScreenRequestSchema, ScreeningDecisionSchema, screenerEnvelope } from './schemas.js';

const json = (schema: z.ZodType) => ({ 'application/json': { schema: z.toJSONSchema(schema, { io: 'input' }) } });
const DecisionEnvelope = screenerEnvelope(ScreeningDecisionSchema);
const HistoryEnvelope = screenerEnvelope(z.array(ScreeningDecisionSchema));
const decision = (description: string) => ({ description, content: json(DecisionEnvelope) });
const walletParam = {
  name: 'wallet',
  in: 'path',
  required: true,
  description: 'Base58 Solana adresi',
  schema: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' },
};
const common = {
  '400': decision('Geçersiz istek (`invalid_input`)'),
  '401': decision('API anahtarı yok ya da geçersiz (`unauthorized`)'),
  '429': decision('Hız sınırı (`rate_limited`); `Retry-After` başlığına uyun'),
  '503': decision('Veritabanı kullanılamıyor (`db_unavailable`)'),
};

export function openapiDocument(info: { name: string; version: string }) {
  return {
    openapi: '3.1.0',
    info: {
      title: info.name,
      version: info.version,
      description:
        'Square sanctions screening servisi (BE-16). Cüzdanı OFAC SDN listesi ve yapılandırılmışsa ' +
        'Chainalysis sanctions API ile tarar; kaynaklardan biri işaretlerse karar `flagged`, hepsi temizse ' +
        "`clear`. Karar square_registry `record_screening` tx'iyle screener authority anahtarıyla zincire " +
        'yazılır ve denetim kaydına girer. Bir kaynak yanıt vermezse karar verilmez, tx gönderilmez.',
    },
    components: {
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/v1/screenings': {
        post: {
          operationId: 'screenWallet',
          summary: 'Cüzdanı tara ve kararı zincire yaz',
          requestBody: { required: true, content: json(ScreenRequestSchema) },
          responses: {
            '200': decision('Onaylanan karar (`outcome: recorded`)'),
            ...common,
            '502': decision(
              'Karar verildi ama tx yazılamadı (`tx_failed`; varsa `programError`); `details.decisionId` denetim kaydıdır',
            ),
            '503': decision(
              'Bir kaynak yanıt vermedi (`source_unavailable`) ya da veritabanı kullanılamıyor (`db_unavailable`)',
            ),
          },
        },
      },
      '/v1/screenings/{wallet}': {
        get: {
          operationId: 'getScreeningDecision',
          summary: 'Cüzdanın son onaylanmış kararı',
          parameters: [walletParam],
          responses: {
            '200': decision('Son onaylanmış karar'),
            '404': decision('Cüzdan için onaylanmış karar yok (`not_found`)'),
            ...common,
          },
        },
      },
      '/v1/screenings/{wallet}/history': {
        get: {
          operationId: 'listScreeningDecisions',
          summary: 'Cüzdanın denetim geçmişi: bütün kararlar ve başarısız denemeler, yeniden eskiye',
          parameters: [
            walletParam,
            { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: { '200': { description: 'Sayfa', content: json(HistoryEnvelope) }, ...common },
        },
      },
      '/health': {
        get: {
          operationId: 'getHealth',
          summary: 'Süreç sağlığı (zarfsız)',
          security: [],
          responses: { '200': { description: 'Çalışıyor', content: json(HealthSchema) } },
        },
      },
      '/ready': {
        get: {
          operationId: 'getReady',
          summary: 'Veritabanı, RPC, registry config ve taze OFAC listesi (zarfsız)',
          security: [],
          responses: {
            '200': { description: 'Hazır', content: json(HealthSchema) },
            '503': { description: 'Hazır değil', content: json(HealthSchema) },
          },
        },
      },
    },
  };
}
