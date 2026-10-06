import { defineConfig } from 'vitest/config';

// Testler gerçek Postgres ve S3 uyumlu depo (SeaweedFS) konteynerleri açar (Testcontainers, Docker gerekir);
// konteynerler bir kez açılır (test/global-setup.ts) ve dosyalar sırayla koşar. Zincir ve prover, yerel HTTP
// fixture sunucularıdır.
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
