import { defineConfig } from 'vitest/config';

// Birim testleri zincirsizdir: komutların tx'leri bellekteki zincirde kurulur ve çözülür. Gerçek zincirde 8 adım
// devnet kabul koşusunda denenir (docs/deploy/cli-devnet.md).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Süreç giriş noktası: argümanlar ve çıkış kodu; mantığı cli.ts'te ve testli.
      exclude: ['src/bin.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
