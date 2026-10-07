import { describe, expect, it } from 'vitest';
import { matching, metricSum, parseMetrics } from '../src/metrics.js';

const TEXT = [
  '# HELP indexer_reconcile_runs_total Uzlaştırma koşuları, sonuca göre',
  '# TYPE indexer_reconcile_runs_total counter',
  'indexer_reconcile_runs_total{result="clean",service="@squaresdk/solana-indexer"} 2',
  'indexer_reconcile_runs_total{result="drift",service="@squaresdk/solana-indexer"} 1',
  '',
  'indexer_reconcile_drift{table="jobs",service="@squaresdk/solana-indexer"} 0',
  'indexer_reconcile_drift{table="claims",service="@squaresdk/solana-indexer"} 3',
  'process_uptime_seconds 12.5',
  'square_build_info{version="0.1.0",note="a \\"quoted\\" value"} 1 1791353225000',
].join('\n');

describe('Prometheus metin biçimi', () => {
  it('örnekleri, etiketleri ve değerleri okur', () => {
    const samples = parseMetrics(TEXT);
    expect(samples).toHaveLength(6);
    expect(samples[4]).toEqual({ name: 'process_uptime_seconds', labels: {}, value: 12.5 });
    expect(samples[5]?.labels).toEqual({ version: '0.1.0', note: 'a "quoted" value' });
  });

  it('etiket alt kümesiyle toplar ve süzer', () => {
    const samples = parseMetrics(TEXT);
    expect(metricSum(samples, 'indexer_reconcile_runs_total')).toBe(3);
    expect(metricSum(samples, 'indexer_reconcile_runs_total', { result: 'clean' })).toBe(2);
    expect(metricSum(samples, 'indexer_reconcile_runs_total', { result: 'error' })).toBe(0);
    expect(matching(samples, 'indexer_reconcile_drift').map((sample) => sample.labels['table'])).toEqual([
      'jobs',
      'claims',
    ]);
    expect(metricSum(samples, 'yok')).toBe(0);
  });

  it('çözülemeyen satır hatadır', () => {
    expect(() => parseMetrics('bu bir metrik değil {')).toThrow('Prometheus satırı çözülemedi');
  });
});
