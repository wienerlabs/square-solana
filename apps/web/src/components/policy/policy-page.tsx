'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useActor } from '@/components/actor';
import { ActorNotice } from '@/components/actor-notice';
import { useWebConfig } from '@/components/providers';
import { useRole } from '@/components/role-provider';
import { PROGRAM_ID_ENV } from '@/lib/config';
import { ROLE_INFO } from '@/lib/roles';
import { InstitutionPolicies } from './institution-policies';

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">{children}</p>;
}

// Politikayı kurumun yetkilisi yazar: cüzdan ya da kurumun smart account vault'u (FE-21). Institution PDA'sı
// yetkiliden ve square_policy'nin kimliğinden türetilir.
export function PolicyPage() {
  const actor = useActor('institution');
  const owner = actor.address;
  const { programIds } = useWebConfig();
  const { role } = useRole();

  if (!owner) return <Notice>Connect the institution&apos;s wallet to write its spending policies.</Notice>;
  if (!programIds.policy) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.policy}</span> is not set. The commitment binds the
        institution account, which is derived from the square_policy program.
      </Notice>
    );
  }
  if (role !== 'institution') {
    return (
      <Notice>
        Policies are written by the {ROLE_INFO.institution.label} role.{' '}
        {role ? `This wallet is set to ${ROLE_INFO[role].label}. ` : ''}
        <Link href="/app" className="text-link underline">
          Choose the role on the overview
        </Link>
        .
      </Notice>
    );
  }
  return (
    <>
      <ActorNotice actor={actor} />
      <InstitutionPolicies key={owner.toBase58()} owner={owner.toBase58()} policyProgramId={programIds.policy} />
    </>
  );
}
