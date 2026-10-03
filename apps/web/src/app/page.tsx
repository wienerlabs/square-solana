import { NetworkStatus } from '@/components/network-status';
import { WalletPanel } from '@/components/wallet-panel';

export default function HomePage() {
  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-6 py-10 md:grid-cols-2">
      <WalletPanel />
      <NetworkStatus />
    </main>
  );
}
