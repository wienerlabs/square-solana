import type { Metadata } from 'next';
import { ArbitrationPage } from '@/components/arbitration/arbitration-page';

export const metadata: Metadata = { title: 'Arbitration' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Arbitration</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Open disputes for the escrow&apos;s arbitrator panel: the evidence, the votes so far and the deadline. Your vote
        is a resolve_dispute transaction the Square API prepares and your wallet signs.
      </p>
      <div className="mt-6">
        <ArbitrationPage />
      </div>
    </main>
  );
}
