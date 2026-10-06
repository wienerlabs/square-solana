'use client';

import type { ReactNode } from 'react';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { ENV_VARS, PROGRAM_ID_ENV } from '@/lib/config';
import { Notice } from './parts';

export interface PanelContext {
  apiUrl: string;
  escrowProgramId: string;
  /** RPC'nin genesis hash'i (ağ doğrulandı). */
  genesisHash: string;
}

/**
 * Panellerin ön koşulları: listeler Square API'den (indexer), tutarlar ve sayaç escrow'un config'inden okunur;
 * ağ doğrulanmadan hiçbir şey okunmaz.
 */
export function Prerequisites({
  subject,
  children,
}: {
  subject: string;
  children: (context: PanelContext) => ReactNode;
}) {
  const { apiUrl, programIds } = useWebConfig();
  const guard = useNetworkGuard();
  if (!apiUrl) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set. The {subject} panel reads its
        jobs, policies and receivables from the Square API, which indexes the chain.
      </Notice>
    );
  }
  if (!programIds.escrow) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span> is not set. Jobs and receivables live in
        the square_escrow program.
      </Notice>
    );
  }
  if (guard.rpc.state !== 'ready' || guard.rpc.mismatch) {
    return (
      <Notice>
        {guard.rpc.state === 'checking'
          ? `Verifying the network before reading the ${subject} panel…`
          : `The network is not verified, so the ${subject} panel is not read.`}
      </Notice>
    );
  }
  return <>{children({ apiUrl, escrowProgramId: programIds.escrow, genesisHash: guard.rpc.genesisHash })}</>;
}
