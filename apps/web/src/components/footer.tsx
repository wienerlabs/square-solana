'use client';

import { LogoMark } from './logo';
import { useWebConfig } from './providers';

export function Footer() {
  const { cluster } = useWebConfig();
  return (
    <footer className="mt-16 border-t border-border/70">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-caption text-muted">
        <span className="flex items-center gap-2">
          <LogoMark className="size-3.5" />
          Square on Solana
        </span>
        <span className="font-mono">{cluster}</span>
      </div>
    </footer>
  );
}
