import { defineConfig } from 'vitest/config';

// Kapsama eşiği BE-08'in kabul kriteri (≥ %80); altına düşen test koşusu başarısız olur.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/idl/**'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
