import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse, table } from './cu-report.mjs';

test('etiket başına en yüksek ölçüm, etikete göre sıralı; diğer satırlar yok sayılır', () => {
  const rows = parse(
    [
      'running 3 tests',
      '[cu] escrow.raise_dispute: 23327 / 60000',
      '[cu] escrow.finalize_payment (gate yok): 48000 / 80000',
      '[cu] escrow.raise_dispute: 24846 / 60000',
      'test a ... ok',
      '[cu] bozuk satır',
    ].join('\n'),
  );
  assert.deepEqual(rows, [
    { label: 'escrow.finalize_payment (gate yok)', cu: 48000, budget: 80000 },
    { label: 'escrow.raise_dispute', cu: 24846, budget: 60000 },
  ]);
});

test('tablo CU, bütçe ve kullanım oranını yazar', () => {
  const out = table([{ label: 'escrow.lapse_dispute', cu: 18472, budget: 40000 }]);
  assert.match(out, /\| escrow\.lapse_dispute \| 18,472 \| 40,000 \| 46% \|/);
});
