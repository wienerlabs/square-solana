import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createServiceMetrics, httpMetricsMiddleware, metricsResponse } from '../src/metrics.js';

class FakeResponse extends EventEmitter {
  constructor(public statusCode: number) {
    super();
  }
}

describe('service metrics', () => {
  it('servis etiketi, süreç metrikleri ve sürüm bilgisi', async () => {
    const metrics = createServiceMetrics({
      service: 'square-prover',
      version: '0.1.0',
      buildLabels: { artifact_version: 'abc123' },
    });
    const { contentType, body } = await metricsResponse(metrics.registry);
    expect(contentType).toContain('text/plain');
    const build = body.split('\n').find((line) => line.startsWith('square_build_info'));
    for (const label of ['version="0.1.0"', 'artifact_version="abc123"', 'service="square-prover"']) {
      expect(build).toContain(label);
    }
    expect(build?.endsWith(' 1')).toBe(true);
    expect(body).toContain('process_cpu_user_seconds_total');
  });

  it('istekleri yanıt bitince yol şablonuyla sayar ve süresini ölçer', async () => {
    const metrics = createServiceMetrics({ service: 's', version: '1' });
    const middleware = httpMetricsMiddleware(metrics, (req: { method: string; route: string }) => req.route);
    let nextCalled = false;
    const res = new FakeResponse(201);
    middleware({ method: 'POST', route: '/v1/prove' }, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect((await metrics.httpRequests.get()).values).toHaveLength(0);
    res.emit('finish');
    const counted = (await metrics.httpRequests.get()).values;
    expect(counted).toEqual([
      expect.objectContaining({ value: 1, labels: { method: 'POST', route: '/v1/prove', status: '201' } }),
    ]);
    const { body } = await metricsResponse(metrics.registry);
    // Etiketlerin sırası istemcinin işidir; satırda hepsi ve değer aranır.
    const count = body.split('\n').find((line) => line.startsWith('http_request_duration_seconds_count'));
    for (const label of ['service="s"', 'method="POST"', 'route="/v1/prove"', 'status="201"']) {
      expect(count).toContain(label);
    }
    expect(count?.endsWith(' 1')).toBe(true);
  });
});
