'use client';

import { useNetworkGuard } from './network-guard';

// Ağ koruması işlemi kapattığında her sayfada, başlığın altında görünür.
export function NetworkBanner() {
  const { problems } = useNetworkGuard();
  if (problems.length === 0) return null;
  return (
    <div role="alert" className="border-b border-border bg-tone-danger-bg">
      <div className="mx-auto max-w-5xl px-6 py-3 text-sm">
        <p className="font-medium text-danger-text">Transactions are disabled</p>
        <ul className="mt-1 space-y-0.5 text-tone-fg">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
