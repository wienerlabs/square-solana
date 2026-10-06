import { defineConfig } from 'vitest/config';

// Birim testleri zincirsizdir (yapılandırma, anahtarlar, gönderici, loader hesapları, init'in Squads yolu,
// Markdown). Zincirle çalışan akışlar (`runSmoke`, fiat varyantı, localnet koşucusunun süreç yönetimi, prover) gerçek
// işlemlerle `smoke:localnet` koşusunda sınanır; raporu docs/deploy/smoke-localnet.md, CI'da smoke.yml.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/smoke.ts', 'src/fiat.ts', 'src/localnet.ts', 'src/prover.ts', 'src/snarkjs.d.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
