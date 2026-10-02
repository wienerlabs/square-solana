// Ortam değişkeniyle mock / gerçek API geçişi.
//
// Varsayılan `live`: mock yalnızca açıkça istenirse açılır. Covenant'ta settlement modunun varsayılanı
// "simulated" olduğu için gerçek ağ hiç denenmemişti (analiz R14); aynı hatayı burada tekrarlamamak
// için mock, production'da ayrıca açık bir izin ister.
import { createApiClient, type ApiClientConfig, type SquareApi } from '@squaresdk/solana-sdk';
import { createMockApi, type MockApiOptions } from './api.js';

export type ApiMode = 'mock' | 'live';
export type Env = Readonly<Record<string, string | undefined>>;

/** Okunan değişkenler. Next.js tarayıcıda yalnızca `NEXT_PUBLIC_` önekli olanları görür. */
export const API_MODE_VARIABLES = ['SQUARE_API_MODE', 'NEXT_PUBLIC_SQUARE_API_MODE'] as const;
/** `NODE_ENV=production` iken mock'a izin veren değişken (ör. kayıtlı demo yedeği, FE-16). */
export const ALLOW_MOCK_IN_PRODUCTION = 'SQUARE_ALLOW_MOCK_IN_PRODUCTION';

export function resolveApiMode(env: Env): ApiMode {
  const values = API_MODE_VARIABLES.map((name) => env[name]).filter((v): v is string => v !== undefined && v !== '');
  const [mode] = values;
  if (mode === undefined) return 'live';
  if (values.some((v) => v !== mode)) {
    throw new Error(`${API_MODE_VARIABLES.join(' ve ')} farklı değerler taşıyor: ${values.join(', ')}`);
  }
  if (mode !== 'mock' && mode !== 'live') {
    throw new Error(`Geçersiz API modu "${mode}": "mock" ya da "live" olmalı`);
  }
  return mode;
}

export interface CreateSquareApiOptions {
  /** Varsayılan: Node'da `process.env`, tarayıcıda boş (yani `live`). */
  env?: Env;
  /** Verilirse ortam değişkenlerinin yerine geçer. */
  mode?: ApiMode;
  /** `live` için API istemcisi ayarları (BE-18). */
  client?: ApiClientConfig;
  /** `mock` için senaryo ayarları. */
  mock?: MockApiOptions;
}

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

export function createSquareApi(options: CreateSquareApiOptions = {}): SquareApi {
  const env = options.env ?? processEnv();
  const mode = options.mode ?? resolveApiMode(env);
  if (mode === 'mock') {
    if (env.NODE_ENV === 'production' && env[ALLOW_MOCK_IN_PRODUCTION] !== '1') {
      throw new Error(`Mock API production'da kapalı; bilinçli kullanım için ${ALLOW_MOCK_IN_PRODUCTION}=1 verin`);
    }
    return createMockApi(options.mock);
  }
  if (!options.client) throw new Error('live mod API istemci ayarı (client.baseUrl) ister');
  return createApiClient(options.client);
}
