import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeExpr, checkMonitoring, definedMetrics, loadRepository } from './monitoring.mjs';

const DEFAULT_BUCKETS = [0.5, 1, 5];
const SOURCES = [
  {
    file: 'apps/x/src/metrics.ts',
    text: `
export const DELAY_BUCKETS = [30, 60, 21_600] as const;
new Histogram({
  name: 'x_delay_seconds',
  help: 'gecikme',
  labelNames: ['gate'],
  buckets: [...DELAY_BUCKETS],
  registers,
});
new Histogram({ name: 'x_duration_seconds', help: 'süre', registers });
new Counter({
  name: 'x_requests_total',
  help: 'istekler',
  registers,
});
new Gauge({
  name: 'x_queue',
  help: 'kuyruk',
  registers: [registry],
  collect() {
    this.set(limiter.stats().queued);
  },
});`,
  },
];

const rules = (body) => `groups:\n  - name: g\n    rules:\n${body}`;
const alert = (expr, extra = '') =>
  `      - alert: A\n        expr: '${expr}'\n        labels:\n          severity: critical\n        annotations:\n          summary: s\n${extra}`;
const dashboard = (...exprs) =>
  JSON.stringify({
    panels: [
      { type: 'row', title: 'satır' },
      { type: 'stat', title: 'p', targets: exprs.map((expr, index) => ({ refId: String(index), expr })) },
    ],
  });
const check = (rulesText, dashboardText = dashboard()) =>
  checkMonitoring({ rulesText, dashboardText, sources: SOURCES, defaultBuckets: DEFAULT_BUCKETS });

test('metrik tanımları: tür, histogram sınırları sabitten, diziden ya da varsayılandan', () => {
  const metrics = definedMetrics(SOURCES, DEFAULT_BUCKETS);
  assert.deepEqual(Object.fromEntries(metrics), {
    x_delay_seconds: { kind: 'Histogram', buckets: [30, 60, 21600] },
    x_duration_seconds: { kind: 'Histogram', buckets: DEFAULT_BUCKETS },
    x_requests_total: { kind: 'Counter', buckets: null },
    x_queue: { kind: 'Gauge', buckets: null },
  });
});

test('ifade analizi: seriler, kova başvuruları ve sözdizimi hatası', () => {
  assert.deepEqual(analyzeExpr('sum(rate(x_delay_seconds_bucket{gate="none",le="60"}[5m])) / sum(rate(y[5m]))'), {
    invalid: false,
    series: ['x_delay_seconds_bucket', 'y'],
    buckets: [{ series: 'x_delay_seconds_bucket', le: 60 }],
  });
  assert.equal(analyzeExpr('sum(rate(x[5m])').invalid, true);
});

test('geçerli kurallar ve pano: kayıt kuralı ve histogram alt serileri tanınır, Grafana aralığı ayrıştırılır', () => {
  const text = rules(
    [
      `      - record: slo:x:error_ratio_rate5m`,
      `        expr: '1 - sum(rate(x_delay_seconds_bucket{le="60"}[5m])) / sum(rate(x_delay_seconds_count[5m]))'`,
      alert('slo:x:error_ratio_rate5m > 0.144 and max(x_queue) > 0'),
    ].join('\n'),
  );
  const panels = dashboard(
    'sum(increase(x_requests_total[$__range]))',
    'histogram_quantile(0.95, sum by (le) (rate(x_duration_seconds_bucket{le="5"}[5m])))',
  );
  assert.deepEqual(check(text, panels), []);
});

test('tanımsız seri, olmayan kova, sözdizimi hatası ve eksik alarm alanları raporlanır', () => {
  const text = rules(
    [
      alert('rate(x_delay_seconds_bucket{le="45"}[5m]) > 0'),
      `      - alert: B\n        expr: x_queue > 0\n        labels:\n          severity: page`,
    ].join('\n'),
  );
  const panels = dashboard(
    'sum(rate(x_missing_total[5m]))',
    'sum(rate(x_requests_total[5m])',
    'x_duration_seconds_bucket{le="2"}',
  );
  assert.deepEqual(check(text, panels), [
    'g/B: severity critical ya da warning olmalı',
    'g/B: annotations.summary yok',
    'g/A: x_delay_seconds histogramında le="45" kovası yok',
    'p/0: tanımlı olmayan seri x_missing_total',
    'p/1: PromQL sözdizimi hatalı: sum(rate(x_requests_total[5m])',
    'p/2: x_duration_seconds histogramında le="2" kovası yok',
  ]);
});

test('repodaki Prometheus kuralları ve Grafana panosu servislerin metrikleriyle uyumlu', () => {
  const repository = loadRepository();
  const metrics = definedMetrics(repository.sources, repository.defaultBuckets);
  for (const name of ['indexer_ingest_delay_seconds', 'keeper_finalize_delay_seconds', 'prover_proving_seconds']) {
    assert.equal(metrics.get(name)?.kind, 'Histogram', name);
  }
  assert.deepEqual(checkMonitoring(repository), []);
});
