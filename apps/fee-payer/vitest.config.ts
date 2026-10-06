import { defineConfig } from 'vitest/config';

// Testler gerçek Postgres konteyneri açar (Testcontainers, Docker gerekir); konteyner bir kez açılır
// (test/global-setup.ts) ve dosyalar sırayla koşar. Zincir yerel bir HTTP fixture sunucusudur; gerçek
// localnet'e gönderim `SQUARE_LOCALNET=1` ile (test/localnet.test.ts).
export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Süreç giriş noktası: yapılandırma ve sinyal bağlama; parçaları testte.
      exclude: ['src/index.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
