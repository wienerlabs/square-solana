// `POST /v1/prove`: prover servisine (apps/prover, BE-11) vekil. Karar (api-sdk-contract §8.5): API ispat
// üretmez; çağıranın anahtarı API'de `prove` kapsamıyla denetlenir, istek prover'a API'nin servis anahtarıyla
// gider. Prover'ın yanıtı sözleşmedeki zarftır; 400 ve 409 olduğu gibi döner, prover'a ulaşılamaması ya da
// prover'ın kapasite / iç hatası `prover_unavailable` (503) olur. Güven sınırı değişmez: witness politikanın
// kendisidir, servisleri işleten taraf görür (ProveRequest açıklaması). Prover API'nin hazırlığına katılmaz:
// prover düşse de diğer uçlar çalışır.
import { ProveResponseSchema, type ProveRequest, type ProveResponse } from '@squaresdk/solana-types';
import { HttpError } from './http.js';

export interface ProverProxy {
  prove(request: ProveRequest): Promise<ProveResponse>;
}

interface ProverEnvelope {
  success?: unknown;
  data?: unknown;
  error?: { code?: unknown; message?: unknown; details?: unknown } | null;
}

const unavailable = (reason: string) =>
  new HttpError(503, 'prover_unavailable', 'prover kullanılamıyor', null, null, new Error(reason));

export function createProverProxy(config: {
  url: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): ProverProxy {
  const send = config.fetch ?? fetch;
  return {
    async prove(request) {
      let response: Response;
      try {
        response = await send(`${config.url}/v1/prove`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        throw unavailable(error instanceof Error ? error.message : String(error));
      }
      let body: ProverEnvelope;
      try {
        body = (await response.json()) as ProverEnvelope;
      } catch {
        throw unavailable(`prover zarf olmayan yanıt verdi (${response.status})`);
      }
      if (response.ok && body.success === true) {
        const parsed = ProveResponseSchema.safeParse(body.data);
        if (!parsed.success) throw unavailable('prover yanıtı sözleşmeye uymuyor');
        return parsed.data;
      }
      const message = typeof body.error?.message === 'string' ? body.error.message : `prover ${response.status}`;
      const details =
        body.error?.details && typeof body.error.details === 'object'
          ? (body.error.details as Record<string, unknown>)
          : null;
      if (response.status === 400) throw new HttpError(400, 'invalid_input', message, details);
      if (response.status === 409) throw new HttpError(409, 'conflict', message, details);
      // 401: API'nin servis anahtarı prover'da tanımlı değil (yapılandırma); 429 / 503: kapasite; diğerleri iç hata.
      throw unavailable(`prover ${response.status}: ${message}`);
    },
  };
}
