'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { AIP_V1_PROGRAM_ID } from '@squaresdk/solana-identity/constants';
import { useWebConfig } from '@/components/providers';
import { useRole } from '@/components/role-provider';
import { PROGRAM_ID_ENV } from '@/lib/config';
import { ROLE_INFO } from '@/lib/roles';
import { AgentRegistration } from './agent-registration';

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">{children}</p>;
}

// Kaydı agent'ın sahibi imzalar; AgentRecord PDA'sı square_registry'nin kimliğinden ve sahibin anahtarından türetilir.
export function AgentPage() {
  const { publicKey } = useWallet();
  const { programIds } = useWebConfig();
  const { role } = useRole();

  if (!publicKey) return <Notice>Connect the wallet that will own the agent to register it.</Notice>;
  if (!programIds.registry) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.registry}</span> is not set. The agent record and its
        DID are derived from the square_registry program.
      </Notice>
    );
  }
  // v1 programı v2 registry'si olarak çözülmez (did:aip Solana profili §6.1 adım 4, §9.2): bu kimlikle
  // üretilen DID'ler hiçbir çözücüde açılmaz.
  if (programIds.registry === AIP_V1_PROGRAM_ID) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.registry}</span> is the did:aip v1 program. DIDs that
        name it do not resolve as did:aip v2, so registering under it would give the agent an identity nobody can open.
        Square&apos;s registry is deployed under its own program id.
      </Notice>
    );
  }
  if (role !== 'agent') {
    return (
      <Notice>
        Agents are registered by the {ROLE_INFO.agent.label} role.{' '}
        {role ? `This wallet is set to ${ROLE_INFO[role].label}. ` : ''}
        <Link href="/app" className="text-link underline">
          Choose the role on the overview
        </Link>
        .
      </Notice>
    );
  }
  return <AgentRegistration owner={publicKey.toBase58()} registryProgramId={programIds.registry} />;
}
