'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { JobView, PolicyView } from '@squaresdk/solana-types';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, type Column } from '@/components/ui/table';
import {
  dailyUsage,
  ESCROWED_STATUSES,
  jobTotals,
  percentOf,
  readInstitutionOverview,
  type InstitutionOverview,
} from '@/lib/dashboards';
import { readChainTime } from '@/lib/job-detail';
import { readEscrowSetup } from '@/lib/job-wizard';
import { squareApi } from '@/lib/square-api';
import { JOB_STATUS_TONE, statusLabel } from '@/lib/status';
import { useSettlementToken } from '@/lib/use-settlement';
import { JobsTable } from './jobs-table';
import { AddressLink, counted, iso, Notice, Row, Section, Stat, usdcFormatter, type Load } from './parts';
import { Prerequisites, type PanelContext } from './prerequisites';

const shortHex = (hex: string) => `0x${hex.slice(0, 8)}…${hex.slice(-8)}`;

/** Kurum paneli (FE-11): işler, politikalar ve günlük tavan kullanımı. */
export default function InstitutionDashboard({ owner }: { owner: string }) {
  return (
    <Prerequisites subject="institution">{(context) => <InstitutionPanel owner={owner} {...context} />}</Prerequisites>
  );
}

interface Snapshot {
  overview: InstitutionOverview;
  chainNow: number;
}

function InstitutionPanel({ owner, apiUrl, escrowProgramId }: { owner: string } & PanelContext) {
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
      const [overview, chainNow] = await Promise.all([
        readInstitutionOverview(squareApi(apiUrl), lookup.setup, new PublicKey(owner)),
        readChainTime(connection),
      ]);
      return { overview, chainNow };
    };
    read().then(
      (value) => active && setSnapshot({ state: 'ready', value }),
      (error: Error) => active && setSnapshot({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [connection, apiUrl, escrowProgramId, owner, revision]);

  const refresh = (
    <Button
      variant="secondary"
      size="sm"
      loading={snapshot.state === 'loading'}
      onClick={() => setRevision((n) => n + 1)}
    >
      Refresh
    </Button>
  );
  if (snapshot.state === 'loading') return <Notice>Reading the institution…</Notice>;
  if (snapshot.state === 'error') {
    return (
      <Section title="Institution" actions={refresh}>
        <p role="alert" className="text-sm text-danger-text">
          The institution could not be read: {snapshot.message}
        </p>
      </Section>
    );
  }

  const { overview, chainNow } = snapshot.value;
  const mint = token?.mint.toBase58() ?? null;
  const totals = mint ? jobTotals(overview.jobs.items, mint) : null;
  const usage = dailyUsage(overview.operator, chainNow, overview.policies.items);

  const policyColumns: readonly Column<PolicyView>[] = [
    {
      key: 'name',
      header: 'Policy',
      cell: (policy) => (
        <span className="flex flex-col gap-0.5">
          <span>{policy.meta?.name ?? <span className="text-muted">No public name</span>}</span>
          <Address value={policy.address} label="policy address" />
        </span>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      cell: (policy) => <span className="font-mono">v{policy.account.version}</span>,
    },
    {
      key: 'state',
      header: 'State',
      cell: (policy) => (
        <StatusBadge tone={policy.account.active ? 'success' : 'neutral'}>
          {policy.account.active ? 'Active' : 'Inactive'}
        </StatusBadge>
      ),
    },
    {
      key: 'ceiling',
      header: 'Daily ceiling',
      align: 'right',
      cell: (policy) => <span className="font-mono">{usdc(BigInt(policy.account.dailyCeiling))}</span>,
    },
    {
      key: 'commitment',
      header: 'Commitment',
      cell: (policy) => (
        <span className="font-mono" title={policy.account.commitment}>
          {shortHex(policy.account.commitment)}
        </span>
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      cell: (policy) => <span className="font-mono">{iso(policy.account.updatedAt)}</span>,
    },
  ];

  const jobColumns: readonly Column<JobView>[] = [
    {
      key: 'job',
      header: 'Job',
      cell: (job) => <AddressLink href={`/app/jobs/${job.address}`} address={job.address} label="Job" />,
    },
    {
      key: 'agent',
      header: 'Agent',
      cell: (job) => (
        <AddressLink href={`/app/agents/${job.account.agentRecord}`} address={job.account.agentRecord} label="Agent" />
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (job) => <span className="font-mono">{usdc(BigInt(job.account.amount))}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (job) => (
        <StatusBadge tone={JOB_STATUS_TONE[job.account.status]}>{statusLabel(job.account.status)}</StatusBadge>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (job) => <span className="font-mono">{iso(job.account.createdAt)}</span>,
    },
  ];

  return (
    <div className="grid gap-6">
      <Section title="Institution" actions={refresh}>
        {overview.account ? (
          <dl className="grid gap-2 text-sm">
            <Row label="Name">{overview.account.name}</Row>
            <Row label="Institution account">
              <Address value={overview.institution} label="institution account" />
            </Row>
            <Row label="Policies committed">
              <span className="font-mono">{overview.account.policyCount}</span>
            </Row>
            {overview.account.multisigVault && (
              <Row label="Squads vault">
                <Address value={overview.account.multisigVault} label="Squads vault" />
                <span className="text-caption text-muted">its jobs are included</span>
              </Row>
            )}
          </dl>
        ) : (
          <p className="text-sm text-muted">
            This wallet has no institution account yet; it is opened with the first policy.{' '}
            <Link href="/app/policy" className="text-link underline">
              Commit a policy
            </Link>
          </p>
        )}
        {totals && (
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="In escrow"
              value={usdc(totals.escrowed)}
              detail={`${counted(
                ESCROWED_STATUSES.reduce((sum, status) => sum + totals.counts[status], 0),
                'funded job',
              )} not yet paid or refunded`}
            />
            <Stat
              label="Released"
              value={usdc(totals.released)}
              detail={`${counted(totals.counts.released, 'job')} paid out`}
            />
            <Stat label="Not funded" value={totals.counts.open} detail="jobs opened without funds" />
            <Stat
              label="Refunded or cancelled"
              value={totals.counts.refunded + totals.counts.cancelled}
              detail="jobs whose USDC went back to the institution"
            />
          </dl>
        )}
        {totals && totals.otherMint > 0 && (
          <p className="mt-3 text-caption text-muted">
            {counted(totals.otherMint, 'job')} in another mint than the settlement mint; not in the totals.
          </p>
        )}
      </Section>

      <Section
        title="Daily ceiling"
        description="The verifier keeps one counter per institution and resets it at midnight UTC; each release proof checks the counter plus the payment against the policy's public daily ceiling."
      >
        <dl className="grid gap-2 text-sm">
          <Row label="Spent today (UTC)">
            <span className="font-mono">{usage.spent === null ? 'Unknown' : usdc(usage.spent)}</span>
          </Row>
          <Row label="Resets at">
            <span className="font-mono">{iso(usage.resetsAt)}</span>
          </Row>
          {overview.operator && (
            <Row label="Releases recorded by the verifier">
              <span className="font-mono">{overview.operator.totalLifetimePayments.toString()}</span>
            </Row>
          )}
        </dl>
        {usage.spent === null && (
          <p className="mt-3 text-caption text-muted">
            The counter belongs to a later day than the chain clock reports; it is read again on refresh.
          </p>
        )}
        {usage.ceilings.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No active policy, so no ceiling applies.</p>
        ) : (
          <ul className="mt-4 grid gap-3">
            {usage.ceilings.map((ceiling) => {
              const used = usage.spent === null ? null : percentOf(usage.spent, ceiling.ceiling);
              const width = usage.spent === null ? 0 : Math.min(100, Number((usage.spent * 100n) / ceiling.ceiling));
              return (
                <li key={ceiling.policy} className="rounded-card border border-border p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {ceiling.name ?? 'Policy'} <span className="font-mono text-muted">v{ceiling.version}</span>
                    </span>
                    <span className="font-mono">{used === null ? '—' : `${used} of ${usdc(ceiling.ceiling)}`}</span>
                  </div>
                  <div aria-hidden="true" className="mt-2 h-2 overflow-hidden rounded-full bg-surface-muted">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
                  </div>
                  {ceiling.remaining !== null && (
                    <p className="mt-2 text-caption text-muted">{usdc(ceiling.remaining)} left today</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="Policies"
        description="Each committed version on chain: the commitment and public ceiling. The rules stay with the institution; only their commitment is public."
        actions={
          <Link href="/app/policy" className="text-sm text-link underline">
            Edit the policy
          </Link>
        }
      >
        <Table
          caption="Policies of this institution"
          columns={policyColumns}
          rows={overview.policies.items}
          rowKey={(policy) => policy.address}
          empty="No policy is committed yet."
        />
        {overview.policies.total > overview.policies.items.length && (
          <p className="mt-2 text-caption text-muted">
            The newest {overview.policies.items.length} of {overview.policies.total} policies are shown.
          </p>
        )}
      </Section>

      <Section
        title="Jobs"
        actions={
          <Link href="/app/jobs/new" className="text-sm text-link underline">
            Open a job
          </Link>
        }
      >
        <JobsTable
          caption="Jobs of this institution"
          jobs={overview.jobs.items}
          total={overview.jobs.total}
          columns={jobColumns}
        />
      </Section>
    </div>
  );
}
