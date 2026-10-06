import { defineConfig } from 'vitest/config';

// Depo ve relayer testleri gerçek Postgres konteyneri açar (Testcontainers, Docker gerekir). Devnet koşusu
// (`test/devnet.e2e.test.ts`) yalnızca `CCTP_E2E_*` ortamıyla çalışır.
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
