// Square ortak ESLint ayarı (flat config). Kök eslint.config.js bunu kullanır.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Üretilen dosyalar ve derleme çıktıları denetlenmez. */
export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/target/**',
  '**/.turbo/**',
  '**/.next/**',
  '**/next-env.d.ts',
  'packages/types/src/generated/**',
  'packages/sdk/src/idl/**',
  'db/src/generated/**',
  'circuits/**/build/**',
];

export default tseslint.config(
  { ignores },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // `_` önekli parametreler bilerek kullanılmaz (arayüz uygulamaları).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // Web uygulamasının bileşenleri tarayıcıda da çalışır.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // CLI betikleri sonucu terminale yazar.
    files: ['**/scripts/**/*.{js,mjs}'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
