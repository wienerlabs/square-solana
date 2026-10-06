import { defineConfig } from 'vitest/config';

// Görev deposu testleri gerçek Postgres konteyneri açar (Testcontainers, Docker gerekir). Localnet e2e testi
// yalnızca SQUARE_LOCALNET=1 ile koşar (test/localnet.e2e.test.ts).
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
