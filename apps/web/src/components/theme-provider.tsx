'use client';

import type { ReactNode } from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

export const THEME_STORAGE_KEY = 'square-theme';

// Tema `data-theme` özniteliğiyle <html>'e yazılır (src/styles/theme.css). Varsayılan sistem tercihi;
// next-themes, seçimi boyamadan önce uygulayan satır içi bir betik ekler (ilk karede yanlış tema yok).
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
    >
      {children}
    </NextThemesProvider>
  );
}
