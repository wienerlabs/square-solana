'use client';

import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import { NetworkStatus } from '@/components/network-status';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { StatusBadge } from '@/components/ui/status-badge';
import { PROGRAMS, type ProgramName } from '@/lib/config';
import { PROGRAM_ROLES } from './content';

type Deployment =
  | { state: 'checking' }
  | { state: 'deployed' }
  | { state: 'missing' }
  | { state: 'not-program' }
  | { state: 'error'; message: string };

function useDeployment(address: string | undefined): Deployment | null {
  const { connection } = useConnection();
  const [deployment, setDeployment] = useState<Deployment | null>(null);

  useEffect(() => {
    if (!address) return;
    let active = true;
    setDeployment({ state: 'checking' });
    connection.getAccountInfo(new PublicKey(address)).then(
      (account) => {
        if (!active) return;
        if (!account) setDeployment({ state: 'missing' });
        else setDeployment({ state: account.executable ? 'deployed' : 'not-program' });
      },
      (error: Error) => active && setDeployment({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [address, connection]);

  return address ? deployment : null;
}

function ProgramRow({ name }: { name: ProgramName }) {
  const { cluster, programIds } = useWebConfig();
  const address = programIds[name];
  const deployment = useDeployment(address);
  const { program, role } = PROGRAM_ROLES[name];

  return (
    <li className="flex flex-col gap-1.5 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm">{program}</span>
        {!address && <StatusBadge tone="neutral">Not configured</StatusBadge>}
        {deployment?.state === 'checking' && <StatusBadge tone="neutral">Checking…</StatusBadge>}
        {deployment?.state === 'deployed' && <StatusBadge tone="success">Deployed on {cluster}</StatusBadge>}
        {deployment?.state === 'missing' && <StatusBadge tone="warning">Not deployed on {cluster}</StatusBadge>}
        {deployment?.state === 'not-program' && <StatusBadge tone="danger">Not a program account</StatusBadge>}
        {deployment?.state === 'error' && <StatusBadge tone="danger">RPC error</StatusBadge>}
      </div>
      <p className="text-sm text-muted">{role}</p>
      {address && <Address value={address} label={`${program} address`} />}
      {deployment?.state === 'error' && <p className="text-caption text-danger-text">{deployment.message}</p>}
    </li>
  );
}

export function OnChain() {
  return (
    <section aria-labelledby="on-chain-title" className="py-12">
      <h2 id="on-chain-title" className="text-heading-sm font-semibold">
        On chain
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Read live from the cluster this deployment is configured for. Program addresses come from the deployment’s
        configuration; a program without one is shown as not configured.
      </p>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section aria-labelledby="programs-title" className="rounded-card border border-border bg-surface p-6">
          <h3 id="programs-title" className="text-sm font-medium tracking-wide text-muted uppercase">
            Programs
          </h3>
          <ul className="mt-4">
            {PROGRAMS.map((name) => (
              <ProgramRow key={name} name={name} />
            ))}
          </ul>
        </section>
        <NetworkStatus />
      </div>
    </section>
  );
}
