import { defineConfig } from 'vitest/config';

// İspat testleri gerçek Groth16 ispatı üretir (her biri birkaç saniye).
export default defineConfig({
  test: {
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
