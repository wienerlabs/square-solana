// Prometheus metrikleri: ortak servis metrikleri (`@squaresdk/solana-observability`: süreç, sürüm, HTTP
// istekleri) ve ispat sonuçları, süreleri, kuyruk durumu. Ayrı bir portta (`PROVER_METRICS_PORT`, iç ağ)
// `GET /metrics` ile sunulur.
import { Counter, Gauge, Histogram, createServiceMetrics, type ServiceMetrics } from '@squaresdk/solana-observability';
import type { Limiter } from './limiter.js';

/** `POST /v1/prove` sonuçları; `prover_proofs_total{result}` etiketi. */
export type ProofResult =
  'ok' | 'unauthorized' | 'invalid_input' | 'invalid_witness' | 'artifact_mismatch' | 'capacity' | 'error';

export interface ProverMetrics extends ServiceMetrics {
  readonly proofs: Counter<'result'>;
  readonly provingSeconds: Histogram;
}

export function createMetrics(params: {
  service: string;
  version: string;
  artifactVersion: string;
  limiter: Limiter;
}): ProverMetrics {
  // `square_build_info{version, artifact_version}`: servis sürümü ve yüklü zkey.
  const base = createServiceMetrics({
    service: params.service,
    version: params.version,
    buildLabels: { artifact_version: params.artifactVersion },
  });
  const { registry } = base;

  new Gauge({
    name: 'prover_active_proofs',
    help: 'Şu anda üretilen ispat sayısı',
    registers: [registry],
    collect() {
      this.set(params.limiter.stats().active);
    },
  });
  new Gauge({
    name: 'prover_queued_requests',
    help: 'Sırada bekleyen ispat isteği sayısı',
    registers: [registry],
    collect() {
      this.set(params.limiter.stats().queued);
    },
  });

  return {
    ...base,
    proofs: new Counter({
      name: 'prover_proofs_total',
      help: 'POST /v1/prove sonuçları',
      labelNames: ['result'],
      registers: [registry],
    }),
    // Kova sınırları istemcinin varsayılanı (5 ms – 10 s).
    provingSeconds: new Histogram({
      name: 'prover_proving_seconds',
      help: 'Başarılı ispatların üretim süresi (witness + ispat + doğrulama)',
      registers: [registry],
    }),
  };
}
