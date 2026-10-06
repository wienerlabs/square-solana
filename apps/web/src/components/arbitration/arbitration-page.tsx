'use client';

import { useWebConfig } from '@/components/providers';
import { PROGRAM_ID_ENV } from '@/lib/config';
import { ArbitrationConsole } from './arbitration-console';

// Konsol arbitrator rolü içindir; kimin oy verebileceği zincirdeki arbitrator setinden okunur.
export function ArbitrationPage() {
  const { programIds } = useWebConfig();
  if (!programIds.escrow) {
    return (
      <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span> is not set. Disputes live in the
        square_escrow program.
      </p>
    );
  }
  return <ArbitrationConsole escrowProgramId={programIds.escrow} />;
}
