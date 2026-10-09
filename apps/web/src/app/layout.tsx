import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { Backdrop } from '@/components/backdrop';
import { CardSpotlight } from '@/components/card-spotlight';
import { ConfigError } from '@/components/config-error';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';
import { NetworkBanner } from '@/components/network-banner';
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
      <body className="flex min-h-screen flex-col">
        <ThemeProvider>
          <Backdrop />
          <CardSpotlight />
          {result.ok ? (
            <Providers config={result.config}>
              <Header />
              <NetworkBanner />
              <div className="flex-1">{children}</div>
              <Footer />
            </Providers>
          ) : (
            <ConfigError errors={result.errors} />
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
