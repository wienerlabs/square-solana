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

  it('her turda koruma denetlenir; koruma hata verirse süre dolmadan düşer', async () => {
    let rounds = 0;
    const started = Date.now();
    await expect(
      until(
        'sonsuz bekleme',
        60_000,
        async () => {
          rounds += 1;
          return null;
        },
        {
          intervalMs: 1,
          guard: async () => {
            if (rounds >= 3) throw new Error('keeper koşu sırasında çıktı');
          },
        },
      ),
    ).rejects.toThrow('keeper koşu sırasında çıktı');
    expect(rounds).toBe(3);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('sorgu hata verirse koruma yeniden denetlenir; koruma geçerse sorgunun hatası döner', async () => {
    let exited = false;
    const probe = async () => {
      exited = true;
      throw new Error('fetch failed');
    };
    await expect(
      until('api', 1_000, probe, {
        guard: async () => {
          if (exited) throw new Error('api koşu sırasında çıktı');
        },
      }),
    ).rejects.toThrow('api koşu sırasında çıktı');
    await expect(until('api', 1_000, probe, { guard: async () => {} })).rejects.toThrow('fetch failed');
  });
});
