import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { ConfigError } from '@/components/config-error';
import { Header } from '@/components/header';
import { Providers } from '@/components/providers';
import { ThemeProvider } from '@/components/theme-provider';
import { parseWebConfig } from '@/lib/config';
import { openRunde } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Square', template: '%s | Square' },
  description: 'Compliance-gated settlement for autonomous agent work on Solana.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Yapılandırma istek anında okunur: aynı imaj, Railway'in her environment'ında kendi değerleriyle çalışır.
  await connection();
  const result = parseWebConfig(process.env);

  return (
    // suppressHydrationWarning: next-themes, temayı boyamadan önce <html data-theme>'e yazar.
    <html lang="en" className={openRunde.variable} suppressHydrationWarning>
      <body className="min-h-screen">
        <ThemeProvider>
          {result.ok ? (
            <Providers config={result.config}>
              <Header />
              {children}
            </Providers>
          ) : (
            <ConfigError errors={result.errors} />
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
