'use client';

import { useWebConfig } from '@/components/providers';
import { PROGRAM_ID_ENV } from '@/lib/config';
import { ClaimMarket } from './claim-market';

// Piyasa herkese açıktır; alım iş sayfasında, bağlı cüzdanla yapılır.
export function ClaimsPage() {
  const { programIds } = useWebConfig();
  if (!programIds.escrow) {
    return (
      <p className="card p-6 text-sm text-muted">
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span> is not set. Receivables are listed in
        the square_escrow program.
      </p>
    );
  }
  return <ClaimMarket escrowProgramId={programIds.escrow} />;
}
