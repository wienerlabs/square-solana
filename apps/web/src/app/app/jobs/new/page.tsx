import type { Metadata } from 'next';
import { NewJobPage } from '@/components/jobs/jobs-page';

export const metadata: Metadata = { title: 'New job' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Open and fund a job</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Bind a registered agent to a job, lock its USDC in the job&apos;s vault and, optionally, gate the release on a
        compliance proof against one of your spending policies. Both wallets need a clear sanctions screening to fund.
      </p>
      <div className="mt-6">
        <NewJobPage />
      </div>
    </main>
  );
}
