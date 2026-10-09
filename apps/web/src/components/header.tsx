'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
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
  { href: '/docs', label: 'Docs' },
] as const;

/** Sayfa aşağı kaydırıldı mı: navbar'ın gölgesi ve zemini buna göre belirginleşir. */
function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > threshold);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [threshold]);
  return scrolled;
}

export function Header() {
  const { cluster } = useWebConfig();
  const pathname = usePathname();
  const scrolled = useScrolled();
  return (
    <header
      className={`sticky top-0 z-40 border-b backdrop-blur-xl backdrop-saturate-150 transition-[background-color,border-color,box-shadow] duration-300 ${
        scrolled ? 'border-border/80 bg-bg/80 shadow-[0_10px_30px_-18px_rgb(0_0_0/0.45)]' : 'border-border/40 bg-bg/50'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-6 px-6">
        <div className="flex items-center gap-3">
          <Link href="/" className="group flex items-center gap-2.5 text-subheading font-semibold tracking-tight">
            <span className="relative flex size-8 items-center justify-center rounded-[10px] bg-text text-bg shadow-[0_6px_18px_-8px_var(--sq-accent)] transition-transform duration-300 group-hover:rotate-[8deg]">
              <LogoMark className="size-4" />
            </span>
            Square
          </Link>
          <span className="hidden items-center gap-1.5 rounded-md border border-border/80 bg-surface/60 px-2 py-0.5 font-mono text-caption text-muted sm:inline-flex">
            <span aria-hidden="true" className="relative flex size-1.5">
              <span className="absolute inline-flex size-full rounded-full bg-tone-success-dot motion-safe:animate-[sq-ping_2.4s_ease-out_infinite]" />
              <span className="relative inline-flex size-1.5 rounded-full bg-tone-success-dot" />
            </span>
            {cluster}
          </span>
        </div>
        <nav aria-label="Main" className="order-last hidden gap-6 text-sm sm:order-none sm:flex">
          {LINKS.map((link) => {
            const current = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={current ? 'page' : undefined}
                className={`relative py-1 transition-colors after:absolute after:inset-x-0 after:-bottom-[21px] after:h-px after:origin-left after:bg-text after:transition-transform after:duration-300 ${
                  current
                    ? 'font-medium text-text after:scale-x-100'
                    : 'text-muted after:scale-x-0 hover:text-text hover:after:scale-x-100'
                }`}
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
      <nav aria-label="Main (compact)" className="flex gap-1 border-t border-border/60 px-4 py-2 text-sm sm:hidden">
        {LINKS.map((link) => {
          const current = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={current ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 ${current ? 'bg-surface-muted font-medium text-text' : 'text-muted'}`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
