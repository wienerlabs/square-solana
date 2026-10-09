'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LAMPORTS_PER_SOL, type PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { sessionUsable } from '@/lib/api-session';
import { ENV_VARS, PROGRAM_ID_ENV } from '@/lib/config';
import { formatUnits, type SettlementToken } from '@/lib/settlement';
import { useSettlementToken, useTokenBalance } from '@/lib/use-settlement';
import { useActor } from './actor';
import { useApiSession } from './api-session';
import { useRole } from './role-provider';
import { useWebConfig } from './providers';
import { Address } from './ui/address';
import { Button } from './ui/button';

type Balance = { status: 'loading' } | { status: 'ready'; lamports: number } | { status: 'error'; message: string };

const formatSol = (lamports: number) =>
  (lamports / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 9 });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Oturumun bitişinin yeniden değerlendirilme aralığı. */
const SESSION_CLOCK_MS = 15_000;

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

/** Square API oturumu (FE-03): durumu, açma ve kapatma. Yenileme, oturum gereken bir sonraki istekte yeni imzadır. */
function ApiSessionRow({ wallet }: { wallet: PublicKey }) {
  const { apiUrl } = useWebConfig();
  const api = useApiSession();
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), SESSION_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const session = api.session;
  const usable = sessionUsable(session, wallet.toBase58(), now);
  const signIn = () => void api.signIn().catch(() => undefined);

  return (
    <>
      <dt className="text-muted">Square API</dt>
      <dd className="flex flex-col items-start gap-2">
        {!apiUrl && (
          <span className="text-muted">
            Unavailable: <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set
          </span>
        )}
        {apiUrl && api.unavailable && <span className="text-muted">{api.unavailable}</span>}
        {apiUrl && !api.unavailable && usable && session && (
          <>
            <span>Signed in until {iso(session.expiresAt)}</span>
            <Button variant="secondary" size="sm" onClick={() => void api.signOut()}>
              Sign out
            </Button>
          </>
        )}
        {apiUrl && !api.unavailable && !usable && (
          <>
            <span className="text-muted">
              {session
                ? `The session ends at ${iso(session.expiresAt)}; the next request asks for a new signature.`
                : 'Not signed in. Deliveries are uploaded with a session; signing in proves this wallet with a signed message, not a transaction.'}
            </span>
            <Button variant="secondary" size="sm" onClick={signIn} loading={api.signingIn}>
              {session ? 'Sign in again' : 'Sign in'}
            </Button>
          </>
        )}
        {api.error && <span className="text-danger-text">{api.error}</span>}
      </dd>
    </>
  );
}

/** Seçili rolün hesabı (FE-21): ücreti kim ödüyor, rol smart account'la çalışıyorsa vault ve USDC'si. */
function ActorRows() {
  const { role } = useRole();
  const actor = useActor(role);
  if (actor.mode === 'wallet') return null;
  return (
    <>
      <dt className="text-muted">Fees</dt>
      <dd className="flex flex-col items-start gap-1">
        <span>Paid by the sponsor</span>
        {actor.problem && <span className="text-danger-text">{actor.problem}</span>}
        <Link href="/app/account" className="text-link underline">
          Manage the account
        </Link>
      </dd>
      {actor.mode === 'smartAccount' && actor.address && (
        <>
          <dt className="text-muted">Acting as</dt>
          <dd>
            <Address value={actor.address.toBase58()} label="vault" />
          </dd>
          <UsdcRow owner={actor.address} />
        </>
      )}
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
          <ApiSessionRow wallet={publicKey} />
          <ActorRows />
        </dl>
      ) : (
        <p className="mt-4 text-sm text-muted">Connect a wallet to see its address and balances.</p>
      )}
    </section>
  );
}
