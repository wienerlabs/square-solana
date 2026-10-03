'use client';

import { useEffect, useState } from 'react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';

type Balance = { status: 'loading' } | { status: 'ready'; lamports: number } | { status: 'error'; message: string };

const formatSol = (lamports: number) =>
  (lamports / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 9 });

export function WalletPanel() {
  const { connection } = useConnection();
  const { publicKey, wallet } = useWallet();
  const [balance, setBalance] = useState<Balance>({ status: 'loading' });

  useEffect(() => {
    if (!publicKey) return;
    let active = true;
    setBalance({ status: 'loading' });
    connection
      .getBalance(publicKey, 'confirmed')
      .then((lamports) => active && setBalance({ status: 'ready', lamports }))
      .catch((error: Error) => active && setBalance({ status: 'error', message: error.message }));
    // Bakiye değişince hesap aboneliği günceller (RPC'nin WebSocket ucu üzerinden).
    const subscription = connection.onAccountChange(
      publicKey,
      (account) => active && setBalance({ status: 'ready', lamports: account.lamports }),
      { commitment: 'confirmed' },
    );
    return () => {
      active = false;
      void connection.removeAccountChangeListener(subscription);
    };
  }, [connection, publicKey]);

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-6">
      <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">Wallet</h2>
      {publicKey ? (
        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-500">Wallet</dt>
          <dd>{wallet?.adapter.name}</dd>
          <dt className="text-neutral-500">Address</dt>
          <dd className="font-mono break-all">{publicKey.toBase58()}</dd>
          <dt className="text-neutral-500">Balance</dt>
          <dd className="font-mono">
            {balance.status === 'ready' && `${formatSol(balance.lamports)} SOL`}
            {balance.status === 'loading' && '…'}
            {balance.status === 'error' && <span className="text-red-700">{balance.message}</span>}
          </dd>
        </dl>
      ) : (
        <p className="mt-4 text-sm text-neutral-600">Connect a wallet to see its address and balance.</p>
      )}
    </section>
  );
}
