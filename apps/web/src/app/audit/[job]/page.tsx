import type { Metadata } from 'next';
import { JobAuditPage } from '@/components/audit/job-audit';
import { isAddress } from '@/lib/config';

export const metadata: Metadata = { title: 'Audit' };

export default async function Page({ params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;
  return (
    // Uygulama düzeniyle (app/layout) aynı genişlik; denetim sayfası herkese açık olduğu için uygulama gezinmesi yok.
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-heading-sm font-semibold">Audit trail</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        A job&apos;s compliance history, open to anyone: its events and transactions, and what the compliance proof
        decided. The institution&apos;s policy stays private; only its commitment is on chain.
      </p>
      <div className="mt-6">
        {isAddress(job) ? (
          <JobAuditPage jobAddress={job} />
        ) : (
          <p className="card p-6 text-sm text-muted">This is not a job address.</p>
        )}
      </div>
    </main>
  );
}
