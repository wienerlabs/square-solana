import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Her ispat birkaç saniye sürer; release devresinin wasm'ı ve zkey'i yüklenir.
    testTimeout: 120_000,
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
