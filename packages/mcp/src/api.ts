// Square REST API erişimi. İstemci SDK'nın `createApiClient`'ıdır (BE-18); burada yalnızca istek zaman aşımı
// eklenir ve zarf açılır: başarısız zarf `SquareApiError` olur, böylece tool'lar API'nin hata kodunu
// (`not_found`, `simulation_failed` …) ve zincir hatasını (`programError`) agent'a aynen taşır.
import { createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import type { ApiEnvelope, ApiError, ResponseMeta } from '@squaresdk/solana-types';

export class SquareApiError extends Error {
  constructor(
    readonly code: ApiError['code'],
    message: string,
    readonly programError: ApiError['programError'] = null,
    readonly details: ApiError['details'] = null,
  ) {
    super(message);
    this.name = 'SquareApiError';
  }
}

export function createApi(options: {
  apiUrl: string;
  timeoutMs: number;
  apiKey: string | null;
  fetch?: typeof fetch;
}): SquareApi {
  const send = options.fetch ?? fetch;
  return createApiClient({
    baseUrl: options.apiUrl,
    ...(options.apiKey ? { auth: { apiKey: options.apiKey } } : {}),
    fetch: (input, init) => send(input, { ...init, signal: AbortSignal.timeout(options.timeoutMs) }),
  });
}

/** Zarfı açar; başarısız zarf `SquareApiError` fırlatır. */
export async function unwrap<T>(pending: Promise<ApiEnvelope<T>>): Promise<{ data: T; meta: ResponseMeta }> {
  const envelope = await pending;
  if (!envelope.success) {
    const { error } = envelope;
    throw new SquareApiError(error.code, error.message, error.programError, error.details);
  }
  return { data: envelope.data, meta: envelope.meta };
}

/** `not_found` null döner; diğer hatalar fırlatılır. */
export async function unwrapOrNull<T>(pending: Promise<ApiEnvelope<T>>): Promise<T | null> {
  try {
    return (await unwrap(pending)).data;
  } catch (error) {
    if (error instanceof SquareApiError && error.code === 'not_found') return null;
    throw error;
  }
}
