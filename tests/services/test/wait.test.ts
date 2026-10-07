import { describe, expect, it } from 'vitest';
import { until } from '../src/wait.js';

describe('until', () => {
  it('ilk doğru değeri döner', async () => {
    let calls = 0;
    const value = await until('sayaç', 1_000, async () => (++calls >= 3 ? calls : null), { intervalMs: 1 });
    expect(value).toBe(3);
  });

  it('süre dolunca açıklamayla hata verir', async () => {
    await expect(
      until('hiç olmayan', 20, async () => false, { intervalMs: 5, describe: async () => 'son durum: boş' }),
    ).rejects.toThrow(/zaman aşımı \(0 s\): hiç olmayan\nson durum: boş/);
    await expect(until('açıklamasız', 10, async () => null, { intervalMs: 5 })).rejects.toThrow(
      'zaman aşımı (0 s): açıklamasız',
    );
  });
});
