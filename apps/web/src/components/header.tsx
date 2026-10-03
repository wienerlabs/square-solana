'use client';

import dynamic from 'next/dynamic';
import { useWebConfig } from './providers';

// Butonun etiketi cüzdan durumuna bağlı; sunucuda render edilirse hydration uyuşmazlığı çıkar.
const WalletMultiButton = dynamic(async () => (await import('@solana/wallet-adapter-react-ui')).WalletMultiButton, {
  ssr: false,
});

export function Header() {
  const { cluster } = useWebConfig();
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold tracking-tight">Square</span>
          <span className="rounded-full border border-neutral-300 px-2.5 py-0.5 font-mono text-xs text-neutral-600">
            {cluster}
          </span>
        </div>
        <WalletMultiButton />
      </div>
    </header>
  );
}
