'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { ClaimView } from '@squaresdk/solana-types';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, type Column } from '@/components/ui/table';
import { formatDiscount } from '@/lib/claim-market';
import { buyerTotals, readBuyerClaims, type Listing } from '@/lib/dashboards';
import { readEscrowSetup } from '@/lib/job-wizard';
import { squareApi } from '@/lib/square-api';
import { CLAIM_STATUS_TONE, statusLabel } from '@/lib/status';
import { useSettlementToken } from '@/lib/use-settlement';
import { AddressLink, counted, iso, Notice, Section, Stat, usdcFormatter, type Load } from './parts';
import { Prerequisites, type PanelContext } from './prerequisites';

/** Alıcı paneli (FE-11): cüzdanın aldığı alacaklar. */
export default function BuyerDashboard({ owner }: { owner: string }) {
  return <Prerequisites subject="buyer">{(context) => <BuyerPanel owner={owner} {...context} />}</Prerequisites>;
}

interface Snapshot {
  claims: Listing<ClaimView>;
  keeperFeeBps: number;
}

function BuyerPanel({ owner, apiUrl, escrowProgramId }: { owner: string } & PanelContext) {
  const { connection } = useConnection();
  const settlement = useSettlementToken(escrowProgramId);
  const token = settlement.state === 'ready' ? settlement.token : null;
  const usdc = usdcFormatter(token);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Load<Snapshot>>({ state: 'loading' });

  useEffect(() => {
    let active = true;
    setSnapshot({ state: 'loading' });
    const read = async (): Promise<Snapshot> => {
      const lookup = await readEscrowSetup(connection, new PublicKey(escrowProgramId));
      if (lookup.state !== 'ready') throw new Error('The escrow is not initialized on this network yet.');
      return { claims: await readBuyerClaims(squareApi(apiUrl), owner), keeperFeeBps: lookup.setup.keeperFeeBps };
    };
    read().then(
      (value) => active && setSnapshot({ state: 'ready', value }),
      (error: Error) => active && setSnapshot({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [connection, apiUrl, escrowProgramId, owner, revision]);

  const actions = (
    <div className="flex flex-wrap items-center gap-3">
      <Link href="/app/claims" className="text-sm text-link underline">
        Receivables for sale
      </Link>
      <Button
        variant="secondary"
        size="sm"
        loading={snapshot.state === 'loading'}
        onClick={() => setRevision((n) => n + 1)}
      >
        Refresh
      </Button>
    </div>
  );
  if (snapshot.state === 'loading') return <Notice>Reading the receivables…</Notice>;
  if (snapshot.state === 'error') {
    return (
      <Section title="Receivables" actions={actions}>
        <p role="alert" className="text-sm text-danger-text">
          The receivables could not be read: {snapshot.message}
        </p>
      </Section>
    );
  }

  const { claims, keeperFeeBps } = snapshot.value;
  const totals = buyerTotals(claims.items, keeperFeeBps);
  const columns: readonly Column<ClaimView>[] = [
    {
      key: 'job',
      header: 'Job',
      cell: (claim) => <AddressLink href={`/app/jobs/${claim.job}`} address={claim.job} label="Job" />,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (claim) => (
        <StatusBadge tone={CLAIM_STATUS_TONE[claim.account.status]}>{statusLabel(claim.account.status)}</StatusBadge>
      ),
    },
    {
      key: 'price',
      header: 'Paid',
      align: 'right',
      cell: (claim) => <span className="font-mono">{usdc(BigInt(claim.account.price))}</span>,
    },
    {
      key: 'face',
      header: 'Face value',
      align: 'right',
      cell: (claim) => <span className="font-mono">{usdc(BigInt(claim.account.faceValue))}</span>,
    },
    {
      key: 'discount',
      header: 'Discount',
      align: 'right',
      cell: (claim) => (
        <span className="font-mono">
          {formatDiscount(BigInt(claim.account.price), BigInt(claim.account.faceValue))}
        </span>
      ),
    },
    {
      key: 'bought',
      header: 'Bought',
      cell: (claim) => <span className="font-mono">{iso(claim.account.boughtAt)}</span>,
    },
  ];

  return (
    <Section
      title="Receivables"
      description="Receivables this wallet bought. At release the escrow pays the job's net to the buyer; if the job is refunded the receivable defaults and pays nothing."
      actions={actions}
    >
      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Awaiting release"
          value={usdc(totals.expectedPayout)}
          detail={`${counted(totals.bought.count, 'receivable')}, ${usdc(totals.bought.price)} paid; net of today's keeper fee`}
        />
        <Stat
          label="Settled"
          value={totals.settled.count}
          detail={`${usdc(totals.settled.price)} paid for ${usdc(totals.settled.faceValue)} face value`}
        />
        <Stat
          label="Defaulted"
          value={totals.defaulted.count}
          detail={`${usdc(totals.defaulted.price)} paid; the job was refunded, nothing was paid out`}
        />
      </dl>
      <div className="mt-4">
        <Table
          caption="Receivables bought by this wallet"
          columns={columns}
          rows={claims.items}
          rowKey={(claim) => claim.address}
          empty="This wallet has not bought a receivable yet."
        />
      </div>
      {claims.total > claims.items.length && (
        <p className="mt-2 text-caption text-muted">
          The newest {claims.items.length} of {claims.total} receivables are shown.
        </p>
      )}
    </Section>
  );
}
