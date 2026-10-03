'use client';

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { caip2ChainId, rpcLabel } from '@/lib/config';
import { useWebConfig } from './providers';

const SLOT_REFRESH_MS = 5_000;

type State =
  { status: 'loading' } | { status: 'ready'; genesisHash: string; slot: number } | { status: 'error'; message: string };

export function NetworkStatus() {
  const { connection } = useConnection();
  const { cluster, rpcUrl } = useWebConfig();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (genesisHash: string) => {
      try {
        const slot = await connection.getSlot('confirmed');
        if (active) setState({ status: 'ready', genesisHash, slot });
      } catch (error) {
        if (active) setState({ status: 'error', message: (error as Error).message });
      }
      if (active) timer = setTimeout(() => void refresh(genesisHash), SLOT_REFRESH_MS);
    };

    connection
      .getGenesisHash()
      .then((genesisHash) => refresh(genesisHash))
      .catch((error: Error) => {
        if (active) setState({ status: 'error', message: error.message });
      });

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [connection]);

  return (
    <section className="rounded-card border border-border bg-surface p-6">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Network</h2>
      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">Cluster</dt>
        <dd className="font-mono">{cluster}</dd>
        <dt className="text-muted">RPC</dt>
        <dd className="font-mono break-all">{rpcLabel(rpcUrl)}</dd>
        {state.status === 'ready' && (
          <>
            <dt className="text-muted">Chain ID</dt>
            <dd className="font-mono break-all">{caip2ChainId(state.genesisHash)}</dd>
            <dt className="text-muted">Slot</dt>
            <dd className="font-mono">{state.slot.toLocaleString('en-US')}</dd>
          </>
        )}
      </dl>
      {state.status === 'loading' && <p className="mt-4 text-sm text-muted">Reading the cluster…</p>}
      {state.status === 'error' && (
        <p role="alert" className="mt-4 text-sm text-danger-text">
          RPC request failed: {state.message}
        </p>
      )}
    </section>
  );
}
