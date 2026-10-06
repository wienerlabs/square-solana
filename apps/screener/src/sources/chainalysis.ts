// Chainalysis sanctions screening API'si (ADR 0020): `GET <taban>/api/v1/address/<adres>`, `X-API-Key`
// başlığı. Yanıt `{ identifications: [{ category, name, description, url }] }`; boş dizi adresin yaptırım
// listelerinde olmadığını, dolu dizi listede olduğunu gösterir. Kanıt yanıt gövdesinin SHA-256'sı ve
// eşleşmelerin kategori ve adıdır. 2xx dışı yanıt, zaman aşımı ya da şemaya uymayan gövde kaynağın karar
// vermemesidir (`SourceUnavailableError`); anahtar hata mesajına ve log'a girmez.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readLimited, SourceUnavailableError, type ScreeningSource } from './source.js';

/** Yanıt birkaç KB'dir; daha büyüğü reddedilir. */
const MAX_RESPONSE_BYTES = 256 * 1024;

const ResponseSchema = z.object({
  identifications: z.array(
    z.object({
      category: z.string(),
      name: z.string().nullish(),
      description: z.string().nullish(),
      url: z.string().nullish(),
    }),
  ),
});

export function createChainalysisSource(params: {
  url: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): ScreeningSource {
  const send = params.fetch ?? fetch;
  const unavailable = (message: string, cause?: unknown) =>
    new SourceUnavailableError('chainalysis', message, cause === undefined ? undefined : { cause });

  return {
    name: 'chainalysis',
    async check(wallet) {
      let response: Response;
      try {
        response = await send(`${params.url}/api/v1/address/${encodeURIComponent(wallet)}`, {
          headers: { 'x-api-key': params.apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(params.timeoutMs),
        });
      } catch (error) {
        throw unavailable('Chainalysis API yanıt vermedi', error);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable(`Chainalysis API HTTP ${response.status}`);
      }
      let body: Buffer;
      let parsed: z.infer<typeof ResponseSchema>;
      try {
        body = await readLimited(response, MAX_RESPONSE_BYTES);
        parsed = ResponseSchema.parse(JSON.parse(body.toString('utf8')));
      } catch (error) {
        throw unavailable('Chainalysis yanıtı beklenen biçimde değil', error);
      }
      return {
        source: 'chainalysis',
        flagged: parsed.identifications.length > 0,
        evidence: {
          responseSha256: createHash('sha256').update(body).digest('hex'),
          identifications: parsed.identifications.map((item) => ({
            category: item.category,
            name: item.name ?? null,
          })),
        },
      };
    },
  };
}
