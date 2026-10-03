import { defineConfig } from 'vitest/config';

// Testler gerçek Postgres konteyneriyle çalışır (src/testing.ts); konteyner açılışı ve migration
// uygulaması varsayılan zaman aşımlarını aşabilir.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
