'use client';

import { useEffect, useState } from 'react';
import { LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PROGRAM_ID_ENV } from '@/lib/config';
import { formatUnits, type SettlementToken } from '@/lib/settlement';
import { useSettlementToken, useTokenBalance } from '@/lib/use-settlement';
import { useWebConfig } from './providers';
import { Address } from './ui/address';

type Balance = { status: 'loading' } | { status: 'ready'; lamports: number } | { status: 'error'; message: string };

const formatSol = (lamports: number) =>
  (lamports / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 9 });

function SettlementBalance({ owner, token }: { owner: PublicKey; token: SettlementToken }) {
  const balance = useTokenBalance(owner, token);
  if (balance.state === 'loading') return <>…</>;
  if (balance.state === 'error') return <span className="text-danger-text">{balance.message}</span>;
  return (
    <span className="flex flex-col gap-1">
      <span className="font-mono">{formatUnits(balance.amount ?? 0n, token.decimals)} USDC</span>
      {balance.amount === null && <span className="text-caption text-muted">No token account yet</span>}
      <span className="text-caption text-muted">
        Mint <Address value={token.mint.toBase58()} />
      </span>
    </span>
  );
}

function UsdcRow({ owner }: { owner: PublicKey }) {
  const { cluster, programIds } = useWebConfig();
  const settlement = useSettlementToken(programIds.escrow);
  return (
    <>
      <dt className="text-muted">USDC</dt>
      <dd>
        {settlement.state === 'ready' && <SettlementBalance owner={owner} token={settlement.token} />}
        {settlement.state === 'loading' && '…'}
        {settlement.state === 'unconfigured' && (
          <span className="text-muted">
            Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span> is not set
          </span>
        )}
        {settlement.state === 'uninitialized' && (
          <span className="text-muted">Unavailable: the escrow config is not initialized on {cluster}</span>
        )}
        {settlement.state === 'error' && <span className="text-danger-text">{settlement.message}</span>}
      </dd>
    </>
  );
}

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
    <section className="rounded-card border border-border bg-surface p-6">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Wallet</h2>
      {publicKey ? (
        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">Wallet</dt>
          <dd>{wallet?.adapter.name}</dd>
          <dt className="text-muted">Address</dt>
          <dd>
            <Address value={publicKey.toBase58()} />
          </dd>
          <dt className="text-muted">SOL</dt>
          <dd className="font-mono">
            {balance.status === 'ready' && formatSol(balance.lamports)}
            {balance.status === 'loading' && '…'}
            {balance.status === 'error' && <span className="text-danger-text">{balance.message}</span>}
          </dd>
          <UsdcRow owner={publicKey} />
        </dl>
      ) : (
        <p className="mt-4 text-sm text-muted">Connect a wallet to see its address and balances.</p>
      )}
    </section>
  );
}
