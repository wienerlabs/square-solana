import type { Metadata } from 'next';
import { JobDetailPage } from '@/components/jobs/job-detail-page';
import { isAddress } from '@/lib/config';

export const metadata: Metadata = { title: 'Job' };

export default async function Page({ params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Job</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        The job as the escrow holds it, its events as they land on chain and, for the agent, accepting and delivering
        the work.
      </p>
      <div className="mt-6">
        {isAddress(job) ? (
          <JobDetailPage jobAddress={job} />
        ) : (
          <p className="card p-6 text-sm text-muted">This is not a job address.</p>
        )}
      </div>
    </main>
  );
}
