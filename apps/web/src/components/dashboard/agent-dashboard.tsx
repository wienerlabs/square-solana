'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { JobView } from '@squaresdk/solana-types';
import { Address, Did } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import type { Column } from '@/components/ui/table';
import { chainRefOf } from '@/lib/agent-registration';
import { agentEarnings, readAgentOverview, readPanelEscrow, type AgentOverview } from '@/lib/dashboards';
import type { SettlementToken } from '@/lib/settlement';
import { squareApi } from '@/lib/square-api';
import { AGENT_STATUS_TONE, CLAIM_STATUS_TONE, JOB_STATUS_TONE, statusLabel } from '@/lib/status';
import { JobsTable } from './jobs-table';
import { AddressLink, counted, iso, Notice, Row, Section, Stat, usdcFormatter, type Load } from './parts';
import { Prerequisites, type PanelContext } from './prerequisites';

/** Agent paneli (FE-11): cüzdanın agent kayıtları, işleri, kazancı ve itibarı. */
export default function AgentDashboard({ owner }: { owner: string }) {
  return <Prerequisites subject="agent">{(context) => <AgentPanel owner={owner} {...context} />}</Prerequisites>;
}

interface Snapshot {
  overview: AgentOverview;
  keeperFeeBps: number;
  token: SettlementToken;
}

function AgentPanel({ owner, apiUrl, escrowProgramId, genesisHash }: { owner: string } & PanelContext) {
  const { connection } = useConnection();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Load<Snapshot>>({ state: 'loading' });

  useEffect(() => {
    let active = true;
    setSnapshot({ state: 'loading' });
    const read = async (): Promise<Snapshot> => {
      const { setup, token } = await readPanelEscrow(connection, new PublicKey(escrowProgramId));
      // Escrow'un okuduğu registry: iş yalnızca onun agent'ına açılır (`AgentNotRegistered`).
      const overview = await readAgentOverview(squareApi(apiUrl), owner, {
        chainRef: chainRefOf(genesisHash),
        registry: setup.registryProgram.toBase58(),
      });
      return { overview, keeperFeeBps: setup.keeperFeeBps, token };
    };
    read().then(
      (value) => active && setSnapshot({ state: 'ready', value }),
      (error: Error) => active && setSnapshot({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [connection, apiUrl, escrowProgramId, genesisHash, owner, revision]);

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
  if (snapshot.state === 'loading') return <Notice>Reading the agents…</Notice>;
  if (snapshot.state === 'error') {
    return (
      <Section title="Agent" actions={refresh}>
        <p role="alert" className="text-sm text-danger-text">
          The agents could not be read: {snapshot.message}
        </p>
      </Section>
    );
  }

  const { overview, keeperFeeBps, token } = snapshot.value;
  const usdc = usdcFormatter(token);
  const mint = token.mint.toBase58();

  const jobColumns: readonly Column<JobView>[] = [
    {
      key: 'job',
      header: 'Job',
      cell: (job) => <AddressLink href={`/app/jobs/${job.address}`} address={job.address} label="Job" />,
    },
    {
      key: 'institution',
      header: 'Institution',
      cell: (job) => <Address value={job.account.institution} label="institution" />,
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
      key: 'receivable',
      header: 'Receivable',
      cell: (job) =>
        job.claim ? (
          <StatusBadge tone={CLAIM_STATUS_TONE[job.claim.status]}>{statusLabel(job.claim.status)}</StatusBadge>
        ) : (
          <span className="text-muted">Not listed</span>
        ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (job) => <span className="font-mono">{iso(job.account.createdAt)}</span>,
    },
  ];

  if (overview.agents.length === 0) {
    return (
      <Section title="Agent" actions={refresh}>
        <p className="text-sm text-muted">
          This wallet owns no agent record on this network.{' '}
          <Link href="/app/agent" className="text-link underline">
            Register an agent
          </Link>
        </p>
        {overview.otherNetwork > 0 && <OtherNetwork count={overview.otherNetwork} />}
      </Section>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {counted(overview.agents.length, 'agent record')} owned by this wallet on this network
        </p>
        {refresh}
      </div>
      {overview.otherNetwork > 0 && <OtherNetwork count={overview.otherNetwork} />}
      {overview.agents.map(({ view, jobs }) => {
        const { account, reputation } = view;
        const earnings = agentEarnings(view, jobs.items, keeperFeeBps, mint);
        return (
          <Section
            key={view.address}
            title={`Agent · ${account.agentId}`}
            actions={
              <Link href={`/app/agents/${view.address}`} className="text-sm text-link underline">
                Profile
              </Link>
            }
          >
            <dl className="grid gap-2 text-sm">
              <Row label="Status">
                <StatusBadge tone={AGENT_STATUS_TONE[account.status]}>{statusLabel(account.status)}</StatusBadge>
              </Row>
              <Row label="DID">
                <Did value={view.did} />
              </Row>
              <Row label="Payout wallet">
                <Address value={account.wallet} label="agent wallet" />
              </Row>
              <Row label="Card">
                {view.cardVerified ? (
                  <StatusBadge tone="success">Verified</StatusBadge>
                ) : (
                  <span className="text-muted">Not verified by the API</span>
                )}
              </Row>
            </dl>

            <h3 className="mt-6 text-sm font-medium">Earnings</h3>
            <dl className="mt-3 grid gap-3 sm:grid-cols-3">
              <Stat
                label="Released"
                value={usdc(earnings.released)}
                detail="Net paid for completed jobs (reputation total_earned), including sold receivables, which the buyers were paid"
              />
              <Stat
                label="Receivables sold"
                value={usdc(earnings.sold.price)}
                detail={`${counted(earnings.sold.count, 'receivable')} sold; the price reached the agent wallet at the sale`}
              />
              <Stat
                label="Awaiting release"
                value={usdc(earnings.pending.net)}
                detail={`${counted(earnings.pending.count, 'funded job')}, net of today's keeper fee`}
              />
            </dl>

            <h3 className="mt-6 text-sm font-medium">Reputation</h3>
            {reputation ? (
              <dl className="mt-3 grid gap-3 sm:grid-cols-3">
                <Stat label="Completed" value={reputation.jobsCompleted} detail="jobs paid out" />
                <Stat label="Failed" value={reputation.jobsFailed} />
                <Stat label="Disputed" value={reputation.jobsDisputed} />
                <Stat
                  label="First settled job"
                  value={<span className="font-mono text-sm">{iso(reputation.firstJobAt)}</span>}
                />
                <Stat
                  label="Last settled job"
                  value={<span className="font-mono text-sm">{iso(reputation.lastJobAt)}</span>}
                />
              </dl>
            ) : (
              <p className="mt-3 text-sm text-muted">
                No settled job yet; reputation is written at the first finalize.
              </p>
            )}

            <h3 className="mt-6 text-sm font-medium">Jobs</h3>
            <div className="mt-3">
              <JobsTable
                caption={`Jobs of agent ${account.agentId}`}
                jobs={jobs.items}
                total={jobs.total}
                columns={jobColumns}
              />
            </div>
          </Section>
        );
      })}
    </div>
  );
}

function OtherNetwork({ count }: { count: number }) {
  return (
    <p className="text-caption text-muted">
      {counted(count, 'agent record')} of this wallet {count === 1 ? 'belongs' : 'belong'} to another network or
      registry and {count === 1 ? 'is' : 'are'} not shown.
    </p>
  );
}
