// Prometheus metrikleri (`@prometheus-io/client`, eski adıyla prom-client): servis başına bir kayıt
// defteri, süreç metrikleri, sürüm bilgisi ve HTTP istek sayacı / süresi. Kayıt defteri `GET /metrics`
// ile, servisin iç ağdaki metrik portundan sunulur.
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

export { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

type HttpLabels = 'method' | 'route' | 'status';

export interface ServiceMetrics {
  readonly registry: Registry;
  readonly httpRequests: Counter<HttpLabels>;
  readonly httpDuration: Histogram<HttpLabels>;
}

export interface ServiceMetricsOptions {
  /** Her metriğe `service` etiketi olarak eklenir. */
  service: string;
  version: string;
  /** `square_build_info`'ya eklenen sürüm etiketleri (ör. yüklü artefaktın sürümü). */
  buildLabels?: Readonly<Record<string, string>>;
}

export function createServiceMetrics(options: ServiceMetricsOptions): ServiceMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.service });
  collectDefaultMetrics({ register: registry });
  const buildLabels = { version: options.version, ...options.buildLabels };
  new Gauge({
    name: 'square_build_info',
    help: 'Servisin sürümü ve sürüm etiketleri; değer her zaman 1',
    labelNames: Object.keys(buildLabels),
    registers: [registry],
  }).set(buildLabels, 1);
  return {
    registry,
    httpRequests: new Counter({
      name: 'http_requests_total',
      help: 'HTTP istekleri',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    // Kova sınırları istemcinin varsayılanı (5 ms – 10 s).
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP isteklerinin süresi',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
  };
}

export interface HttpRequestLike {
  readonly method: string;
}

export interface HttpResponseLike {
  readonly statusCode: number;
  once(event: 'finish', listener: () => void): unknown;
}

/**
 * Her isteği yanıt bitince sayan ve süresini ölçen ara katman (Express uyumlu). `routeOf` eşleşen yol
 * şablonunu verir; ham yol etiket olarak kullanılmaz (kardinalite).
 */
export function httpMetricsMiddleware<Req extends HttpRequestLike, Res extends HttpResponseLike>(
  metrics: ServiceMetrics,
  routeOf: (req: Req) => string,
): (req: Req, res: Res, next: () => void) => void {
  return (req, res, next) => {
    const stop = metrics.httpDuration.startTimer();
    res.once('finish', () => {
      const labels = { method: req.method, route: routeOf(req), status: String(res.statusCode) };
      metrics.httpRequests.inc(labels);
      stop(labels);
    });
    next();
  };
}

/** `GET /metrics` yanıtı: içerik türü ve gövde. */
export async function metricsResponse(registry: Registry): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
