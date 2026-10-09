'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useNetworkGuard } from '@/components/network-guard';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { Table, type Column } from '@/components/ui/table';
import { formatDiscount, readMarket, type BuyerList, type MarketEntry } from '@/lib/claim-market';
import { readEscrowSetup, type EscrowSetupLookup } from '@/lib/job-wizard';
import { formatUnits } from '@/lib/settlement';
import { useSettlementToken } from '@/lib/use-settlement';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const big = (value: { toString(): string }) => BigInt(value.toString());
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const BUYERS: Readonly<Record<BuyerList['kind'], string>> = {
  none: 'Any screened buyer',
  open: 'Any screened buyer (no list published)',
  approved: 'Approved buyers only',
};

/** Satıştaki alacaklar (FE-08): zincirdeki `Listed` listelemeler; alım iş sayfasında yapılır. */
export function ClaimMarket({ escrowProgramId }: { escrowProgramId: string }) {
  const { connection } = useConnection();
  const guard = useNetworkGuard();
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const escrowKey = useMemo(() => new PublicKey(escrowProgramId), [escrowProgramId]);
  const settlementState = useSettlementToken(verified ? escrowProgramId : undefined);
  const token = settlementState.state === 'ready' ? settlementState.token : null;
  const usdc = (base: bigint) => (token ? `${formatUnits(base, token.decimals)} USDC` : base.toString());

  const [setup, setSetup] = useState<Load<EscrowSetupLookup>>({ state: 'loading' });
  useEffect(() => {
    if (!verified) return;
    let active = true;
    readEscrowSetup(connection, escrowKey).then(
      (value) => active && setSetup({ state: 'ready', value }),
      (error: Error) => active && setSetup({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [verified, connection, escrowKey]);
  const escrow = setup.state === 'ready' && setup.value.state === 'ready' ? setup.value.setup : null;

  const [revision, setRevision] = useState(0);
  const [market, setMarket] = useState<Load<MarketEntry[]>>({ state: 'loading' });
  useEffect(() => {
    if (!escrow) return;
    let active = true;
    setMarket({ state: 'loading' });
    readMarket(escrow).then(
      (value) => active && setMarket({ state: 'ready', value }),
      (error: Error) => active && setMarket({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, revision]);

  if (!verified) {
    return (
      <p className="card p-6 text-sm text-muted">
        {guard.rpc.state === 'checking'
          ? 'Verifying the network before reading the listings…'
          : 'The network is not verified, so the listings are not read.'}
      </p>
    );
  }
  if (setup.state === 'loading') return <p className="text-sm text-muted">Reading the escrow…</p>;
  if (setup.state === 'error') return <p className="text-sm text-danger-text">{setup.message}</p>;
  if (!escrow) return <p className="text-sm text-muted">The escrow is not initialized on this network yet.</p>;

  const columns: readonly Column<MarketEntry>[] = [
    {
      key: 'job',
      header: 'Job',
      cell: (entry) => (
        <Link href={`/app/jobs/${entry.job.toBase58()}`} className="font-mono text-link underline">
          {entry.job.toBase58().slice(0, 4)}…{entry.job.toBase58().slice(-4)}
        </Link>
      ),
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      cell: (e) => <span className="whitespace-nowrap font-mono">{usdc(big(e.claim.price))}</span>,
    },
    {
      key: 'face',
      header: 'Pays at release',
      align: 'right',
      cell: (e) => <span className="whitespace-nowrap font-mono">{usdc(big(e.claim.faceValue))}</span>,
    },
    {
      key: 'discount',
      header: 'Discount',
      align: 'right',
      cell: (e) => formatDiscount(big(e.claim.price), big(e.claim.faceValue)),
    },
    { key: 'buyers', header: 'Who can buy', cell: (e) => BUYERS[e.buyers.kind] },
    {
      key: 'gate',
      header: 'Release',
      cell: (e) => (e.account.policy ? 'Compliance proof' : 'No proof gate'),
    },
    { key: 'seller', header: 'Seller', cell: (e) => <Address value={e.claim.seller.toBase58()} label="seller" /> },
    {
      key: 'listed',
      header: 'Listed',
      cell: (e) => <time dateTime={iso(e.claim.listedAt.toNumber())}>{iso(e.claim.listedAt.toNumber())}</time>,
    },
  ];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {market.state === 'ready'
            ? `${market.value.length} receivable${market.value.length === 1 ? '' : 's'} for sale.`
            : 'Reading the listings…'}
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setRevision((n) => n + 1)}
          loading={market.state === 'loading'}
        >
          Refresh
        </Button>
      </div>
      {market.state === 'error' && (
        <p className="text-sm text-danger-text">The listings could not be read: {market.message}</p>
      )}
      {market.state === 'ready' && (
        <Table
          caption="Receivables for sale"
          columns={columns}
          rows={market.value}
          rowKey={(entry) => entry.listing.toBase58()}
          empty="No receivable is for sale right now."
        />
      )}
    </div>
  );
}
