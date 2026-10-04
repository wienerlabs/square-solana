'use client';

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { caip2ChainId, rpcLabel } from '@/lib/config';
import { useNetworkGuard } from './network-guard';
import { useWebConfig } from './providers';
import { StatusBadge } from './ui/status-badge';

const SLOT_REFRESH_MS = 5_000;

type Slot = { status: 'loading' } | { status: 'ready'; slot: number } | { status: 'error'; message: string };

export function NetworkStatus() {
  const { connection } = useConnection();
  const { cluster, rpcUrl } = useWebConfig();
  const { rpc } = useNetworkGuard();
  const [slot, setSlot] = useState<Slot>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const value = await connection.getSlot('confirmed');
        if (active) setSlot({ status: 'ready', slot: value });
      } catch (error) {
        if (active) setSlot({ status: 'error', message: (error as Error).message });
      }
      if (active) timer = setTimeout(() => void refresh(), SLOT_REFRESH_MS);
    };
    void refresh();
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
        <dt className="text-muted">Check</dt>
        <dd>
          {rpc.state === 'checking' && <StatusBadge tone="neutral">Checking…</StatusBadge>}
          {rpc.state === 'ready' && !rpc.mismatch && (
            <StatusBadge tone="success">{cluster === 'localnet' ? 'Local cluster' : `Matches ${cluster}`}</StatusBadge>
          )}
          {rpc.state === 'ready' && rpc.mismatch && <StatusBadge tone="danger">Wrong network</StatusBadge>}
          {rpc.state === 'error' && <StatusBadge tone="danger">RPC error</StatusBadge>}
        </dd>
        {rpc.state === 'ready' && (
          <>
            <dt className="text-muted">Chain ID</dt>
            <dd className="font-mono break-all">{caip2ChainId(rpc.genesisHash)}</dd>
          </>
        )}
        {slot.status === 'ready' && (
          <>
            <dt className="text-muted">Slot</dt>
            <dd className="font-mono">{slot.slot.toLocaleString('en-US')}</dd>
          </>
        )}
      </dl>
      {rpc.state === 'ready' && rpc.mismatch && <p className="mt-4 text-sm text-danger-text">{rpc.mismatch}</p>}
      {rpc.state === 'error' && (
        <p role="alert" className="mt-4 text-sm text-danger-text">
          RPC request failed: {rpc.message}
        </p>
      )}
    </section>
  );
}
