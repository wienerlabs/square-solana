import type { Metadata } from 'next';
import { NetworkStatus } from '@/components/network-status';
import { RolePicker } from '@/components/role-picker';
import { WalletPanel } from '@/components/wallet-panel';

export const metadata: Metadata = { title: 'App' };

export default function AppPage() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Overview</h1>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <WalletPanel />
        <NetworkStatus />
      </div>
      <div className="mt-6">
        <RolePicker />
      </div>
    </main>
  );
}
