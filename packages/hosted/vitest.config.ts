import { defineConfig } from 'vitest/config';

// Uçtan uca test (test/hosted.e2e.test.ts) gerçek Postgres konteyneri açar (Testcontainers, Docker gerekir) ve
// fixture MCP sunucusunu stdio alt süreci olarak çalıştırır. Localnet testi yalnızca SQUARE_LOCALNET=1 ile koşar.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Süreç giriş noktası: argüman okuma ve sinyal bağlama; mantığı runner.ts'te ve testli.
      exclude: ['src/bin.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
