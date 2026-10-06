import { defineConfig } from 'vitest/config';

// Square API'si ve Solana RPC yerel fixture sunucularıdır (test/helpers). stdio uçtan uca testi derlenmiş
// `dist/bin.js`'i alt süreç olarak açar (turbo'da `test`, `build`'e bağlı).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Süreç giriş noktası: argüman ve ortam okuma, sinyal bağlama; alt süreç olarak uçtan uca testte.
      exclude: ['src/bin.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
