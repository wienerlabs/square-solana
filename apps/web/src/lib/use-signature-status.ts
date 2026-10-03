'use client';

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { TxStage } from '@/components/ui/tx-confirmation';

const POLL_MS = 2_000;

export interface SignatureState {
  stage: TxStage;
  error?: string;
}

/** Bir imzanın commitment seviyesini `finalized` olana ya da hata dönene kadar izler. */
export function useSignatureStatus(signature: string | null): SignatureState | null {
  const { connection } = useConnection();
  const [state, setState] = useState<SignatureState | null>(null);

  useEffect(() => {
    if (!signature) {
      setState(null);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ stage: 'sending' });

    const poll = async () => {
      try {
        const { value } = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
        if (!active) return;
        if (value?.err) {
          setState({ stage: 'failed', error: JSON.stringify(value.err) });
          return;
        }
        if (value?.confirmationStatus) setState({ stage: value.confirmationStatus });
        if (value?.confirmationStatus === 'finalized') return;
      } catch (error) {
        if (active) setState({ stage: 'failed', error: (error as Error).message });
        return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [connection, signature]);

  return state;
}
