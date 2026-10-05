'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWebConfig } from '@/components/providers';
import { useRole } from '@/components/role-provider';
import { PROGRAM_ID_ENV } from '@/lib/config';
import { ROLE_INFO } from '@/lib/roles';
import { JobWizard } from './job-wizard';

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">{children}</p>;
}

// İşi kurum cüzdanı açar ve fonlar; diğer programların kimlikleri escrow config'inden okunur.
export function NewJobPage() {
  const { publicKey } = useWallet();
  const { programIds } = useWebConfig();
  const { role } = useRole();

  if (!publicKey) return <Notice>Connect the institution&apos;s wallet to open a job.</Notice>;
  if (!programIds.escrow) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span> is not set. Jobs live in the
        square_escrow program, whose config also names the registry and policy programs.
      </Notice>
    );
  }
  if (role !== 'institution') {
    return (
      <Notice>
        Jobs are opened by the {ROLE_INFO.institution.label} role.{' '}
        {role ? `This wallet is set to ${ROLE_INFO[role].label}. ` : ''}
        <Link href="/app" className="text-link underline">
          Choose the role on the overview
        </Link>
        .
      </Notice>
    );
  }
  return <JobWizard owner={publicKey.toBase58()} escrowProgramId={programIds.escrow} />;
}
