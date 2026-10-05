'use client';

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { settlementAccount, tokenAmount, type SettlementToken } from './settlement';

export type SettlementTokenState =
  | { state: 'unconfigured' }
  | { state: 'loading' }
  | { state: 'uninitialized'; config: string }
  | { state: 'ready'; token: SettlementToken }
  | { state: 'error'; message: string };

/** Escrow programı yapılandırılmışsa zincirdeki settlement token'ı. */
export function useSettlementToken(escrowProgramId: string | undefined): SettlementTokenState {
  const { connection } = useConnection();
  const [state, setState] = useState<SettlementTokenState>({ state: 'loading' });

  useEffect(() => {
    if (!escrowProgramId) return;
    let active = true;
    setState({ state: 'loading' });
    // Anchor yalnızca escrow yapılandırılmışsa ve bakiye gösterilecekse yüklenir.
    import('./settlement-config')
      .then(({ readSettlementToken }) => readSettlementToken(connection, new PublicKey(escrowProgramId)))
      .then(
        (lookup) =>
          active &&
          setState(lookup.state === 'ready' ? lookup : { state: 'uninitialized', config: lookup.config.toBase58() }),
        (error: Error) => active && setState({ state: 'error', message: error.message }),
      );
    return () => {
      active = false;
    };
  }, [connection, escrowProgramId]);

  return escrowProgramId ? state : { state: 'unconfigured' };
}

export type TokenBalance =
  | { state: 'loading' }
  | { state: 'ready'; account: string; amount: bigint | null }
  | { state: 'error'; message: string };

/**
 * Sahibin settlement token bakiyesi (associated token account); hesap değişince güncellenir. Token henüz
 * bilinmiyorsa (`null`) okunmaz, `loading` kalır.
 */
export function useTokenBalance(owner: PublicKey, token: SettlementToken | null): TokenBalance {
  const { connection } = useConnection();
  const [balance, setBalance] = useState<TokenBalance>({ state: 'loading' });

  useEffect(() => {
    if (!token) return;
    let active = true;
    const account = settlementAccount(owner, token);
    const update = (info: Parameters<typeof tokenAmount>[1]) =>
      active && setBalance({ state: 'ready', account: account.toBase58(), amount: tokenAmount(account, info, token) });
    setBalance({ state: 'loading' });
    connection.getAccountInfo(account, 'confirmed').then(update, (error: Error) => {
      if (active) setBalance({ state: 'error', message: error.message });
    });
    // Hesap henüz yoksa da abone olunur: ilk transferle oluşturulduğunda bildirim gelir.
    const subscription = connection.onAccountChange(account, update, { commitment: 'confirmed' });
    return () => {
      active = false;
      void connection.removeAccountChangeListener(subscription);
    };
  }, [connection, owner, token]);

  return balance;
}
