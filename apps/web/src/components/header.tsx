'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogoMark } from './logo';
import { useWebConfig } from './providers';
import { ThemeToggle } from './theme-toggle';

// Butonun etiketi cüzdan durumuna bağlı; sunucuda render edilirse hydration uyuşmazlığı çıkar.
const WalletMultiButton = dynamic(async () => (await import('@solana/wallet-adapter-react-ui')).WalletMultiButton, {
  ssr: false,
});

// Bileşen kataloğu (`/design`, FE-02) ekip içindir; menüde yer almaz.
const LINKS = [
  { href: '/', label: 'Protocol' },
  { href: '/app', label: 'App' },
] as const;

export function Header() {
  const { cluster } = useWebConfig();
  const pathname = usePathname();
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-subheading font-semibold">
            <LogoMark />
            Square
          </Link>
          <span className="rounded-full border border-border px-2.5 py-0.5 font-mono text-caption text-muted">
            {cluster}
          </span>
        </div>
        <nav aria-label="Main" className="order-last flex w-full gap-1 text-sm sm:order-none sm:w-auto">
          {LINKS.map((link) => {
            const current = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={current ? 'page' : undefined}
                className={`rounded-full px-3 py-1.5 ${current ? 'bg-surface-muted font-medium text-text' : 'text-muted hover:text-text'}`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
}
