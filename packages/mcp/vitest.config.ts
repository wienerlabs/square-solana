import { defineConfig } from 'vitest/config';

// Sunucu araçları bellekteki zincire (test/helpers/chain.ts) karşı, MCP SDK'nın bellek içi taşımasıyla; havuz
// hem bellek içi sunucularla hem derlenmiş sunucuyu stdio'yla açarak denenir (dist/, test'ten önce build).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Süreç giriş noktası: yapılandırmayı okuyup stdio'ya bağlar; stdio testi derlenmiş halini koşturur.
      exclude: ['src/bin.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
