import { defineConfig } from 'vitest/config';

// x402 rapor testi gerçek Postgres konteyneri açar (Testcontainers, Docker gerekir); Solana RPC'si sahtedir.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
