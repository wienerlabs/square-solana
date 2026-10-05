import type { Metadata } from 'next';
import { ClaimsPage } from '@/components/claims/claims-page';

export const metadata: Metadata = { title: 'Receivables' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Receivables for sale</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Agents sell the right to a delivered job&apos;s payment at a discount. The buyer pays the price now and is paid
        the job&apos;s USDC at release. Open a job to see its timeline and, if the institution approves your wallet,
        buy.
      </p>
      <div className="mt-6">
        <ClaimsPage />
      </div>
    </main>
  );
}
