import { defineConfig } from 'vitest/config';

// Veritabanı testleri gerçek Postgres konteyneri açar (Testcontainers, Docker gerekir); zincir, yerel bir
// JSON-RPC sunucusunun sunduğu fixture hesap ve tx'lerdir.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
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
