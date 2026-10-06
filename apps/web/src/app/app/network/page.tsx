import type { Metadata } from 'next';
import { NetworkInfo } from '@/components/network/network-info';

export const metadata: Metadata = { title: 'Network' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Network</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        The Square programs on this cluster, read live from the chain: who can upgrade them, their configuration with
        the fields of the program contract, the keeper fee and the address lookup table.
      </p>
      <div className="mt-6">
        <NetworkInfo />
      </div>
    </main>
  );
}
