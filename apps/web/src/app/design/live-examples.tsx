'use client';

// Kataloğun canlı bölümleri: içerik bağlı cüzdandan ve yapılandırılan cluster'ın RPC'sinden gelir.
import { useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Address, Did } from '@/components/ui/address';
import { Table } from '@/components/ui/table';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { caip2ChainId } from '@/lib/config';
import { useSignatureStatus } from '@/lib/use-signature-status';
import { useWebConfig } from '@/components/providers';

function Empty({ children }: { children: string }) {
  return <p className="text-sm text-muted">{children}</p>;
}

export function ConnectedIdentity() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [genesis, setGenesis] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    connection.getGenesisHash().then(
      (hash) => active && setGenesis(hash),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [connection]);

  if (!publicKey) return <Empty>Connect a wallet to show its address and controller DID.</Empty>;
  const address = publicKey.toBase58();
  return (
    <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-3 text-sm">
      <dt className="text-muted">Address</dt>
      <dd>
        <Address value={address} />
      </dd>
      <dt className="text-muted">Controller DID</dt>
      <dd>{genesis ? <Did value={`did:pkh:${caip2ChainId(genesis)}:${address}`} /> : '…'}</dd>
    </dl>
  );
}

interface Sample {
  slot: number;
  numTransactions: number;
  samplePeriodSecs: number;
}

export function PerformanceTable() {
  const { connection } = useConnection();
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    connection.getRecentPerformanceSamples(5).then(
      (rows) => active && setSamples(rows),
      (e: Error) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [connection]);

  if (error) return <p className="text-sm text-danger-text">RPC request failed: {error}</p>;
  return (
    <Table
      caption="Recent performance samples"
      rowKey={(row) => String(row.slot)}
      rows={samples ?? []}
      empty={samples ? 'The RPC returned no samples.' : 'Reading samples…'}
      columns={[
        {
          key: 'slot',
          header: 'Slot',
          cell: (row) => <span className="font-mono">{row.slot.toLocaleString('en-US')}</span>,
        },
        {
          key: 'tx',
          header: 'Transactions',
          align: 'right',
          cell: (row) => row.numTransactions.toLocaleString('en-US'),
        },
        { key: 'period', header: 'Period', align: 'right', cell: (row) => `${row.samplePeriodSecs} s` },
        {
          key: 'tps',
          header: 'TPS',
          align: 'right',
          cell: (row) =>
            (row.numTransactions / row.samplePeriodSecs).toLocaleString('en-US', { maximumFractionDigits: 0 }),
        },
      ]}
    />
  );
}

export function LatestTransaction() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { cluster } = useWebConfig();
  const [signature, setSignature] = useState<string | null | undefined>(undefined);
  const status = useSignatureStatus(signature ?? null);

  useEffect(() => {
    if (!publicKey) return;
    let active = true;
    setSignature(undefined);
    connection.getSignaturesForAddress(publicKey, { limit: 1 }, 'confirmed').then(
      (rows) => active && setSignature(rows[0]?.signature ?? null),
      () => active && setSignature(null),
    );
    return () => {
      active = false;
    };
  }, [connection, publicKey]);

  if (!publicKey) return <Empty>Connect a wallet to follow its latest transaction.</Empty>;
  if (signature === undefined) return <Empty>Reading the wallet&apos;s transactions…</Empty>;
  if (signature === null) return <Empty>{`This wallet has no transactions on ${cluster}.`}</Empty>;
  return <TxConfirmation stage={status?.stage ?? 'sending'} signature={signature} error={status?.error} />;
}

export function TokenSwatches({ names }: { names: readonly { name: string; use: string }[] }) {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const read = () => {
      const style = getComputedStyle(document.documentElement);
      setValues(Object.fromEntries(names.map((t) => [t.name, style.getPropertyValue(t.name).trim()])));
    };
    read();
    // Tema <html data-theme> ile değişir; değerler yeniden okunur.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [names]);

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {names.map((token) => (
        <li key={token.name} className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="size-9 shrink-0 rounded-lg border border-border"
            style={{ background: `var(${token.name})` }}
          />
          <span className="min-w-0 text-sm">
            <span className="block font-mono text-caption">{token.name}</span>
            <span className="block text-muted">
              {token.use}
              {values[token.name] ? ` · ${values[token.name]}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
