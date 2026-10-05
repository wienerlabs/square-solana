'use client';

import { useWebConfig } from '@/components/providers';
import { PROGRAM_ID_ENV } from '@/lib/config';
import { JobDetail } from './job-detail';

// İş detayı herkese açıktır; eylemler bağlı cüzdana göre açılır (agent cüzdanı kabul ve teslim eder).
export function JobDetailPage({ jobAddress }: { jobAddress: string }) {
  const { programIds } = useWebConfig();
  if (!programIds.escrow) {
    return (
      <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span> is not set. Jobs live in the
        square_escrow program.
      </p>
    );
  }
  return <JobDetail jobAddress={jobAddress} escrowProgramId={programIds.escrow} />;
}
