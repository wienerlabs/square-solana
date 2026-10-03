// Prometheus metrikleri: süreç metrikleri, HTTP istekleri, ispat sonuçları ve süreleri, kuyruk
// durumu. Ayrı bir portta (`PROVER_METRICS_PORT`, iç ağ) `GET /metrics` ile sunulur.
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Limiter } from './limiter.js';

/** `POST /v1/prove` sonuçları; `prover_proofs_total{result}` etiketi. */
export type ProofResult =
  'ok' | 'unauthorized' | 'invalid_input' | 'invalid_witness' | 'artifact_mismatch' | 'capacity' | 'error';

export interface ProverMetrics {
  readonly registry: Registry;
  readonly proofs: Counter<'result'>;
  readonly provingSeconds: Histogram;
  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
}

export function createMetrics(params: {
  service: string;
  version: string;
  artifactVersion: string;
  limiter: Limiter;
}): ProverMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: params.service });
  collectDefaultMetrics({ register: registry });

  new Gauge({
    name: 'prover_build_info',
    help: 'Servis sürümü ve yüklü zkey (artefakt sürümü); değer her zaman 1',
    labelNames: ['version', 'artifact_version'],
    registers: [registry],
  }).set({ version: params.version, artifact_version: params.artifactVersion }, 1);

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
    registry,
    proofs: new Counter({
      name: 'prover_proofs_total',
      help: 'POST /v1/prove sonuçları',
      labelNames: ['result'],
      registers: [registry],
    }),
    // Kova sınırları prom-client'ın varsayılanı (5 ms – 10 s).
    provingSeconds: new Histogram({
      name: 'prover_proving_seconds',
      help: 'Başarılı ispatların üretim süresi (witness + ispat + doğrulama)',
      registers: [registry],
    }),
    httpRequests: new Counter({
      name: 'prover_http_requests_total',
      help: 'HTTP istekleri',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
  };
}
