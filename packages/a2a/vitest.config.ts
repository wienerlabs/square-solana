import { defineConfig } from 'vitest/config';

// Depo testleri gerçek Postgres konteyneri açar (Testcontainers, Docker gerekir).
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
