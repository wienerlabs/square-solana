'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { JobAccount } from '@squaresdk/solana-sdk';
import type { ArbitrationQueueItem } from '@squaresdk/solana-types';
import { useApiClient, type ApiClientState } from '@/components/api-client';
import { ApiSessionPanel } from '@/components/api-session-panel';
import { EvidencePanel } from '@/components/dispute/evidence-panel';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  describeResolution,
  disputeFacts,
  disputeParamsOf,
  voteBlock,
  voteChoices,
  voteTally,
  type DisputeParams,
} from '@/lib/dispute';
import { formatDuration, readEscrowSetup, type EscrowSetup, type EscrowSetupLookup } from '@/lib/job-wizard';
import { formatUnits } from '@/lib/settlement';
import { unwrap } from '@/lib/square-api';
import { useChainClock } from '@/lib/use-chain-clock';
import { useSettlementToken } from '@/lib/use-settlement';
import { VoteForm } from './vote-form';
import { WebhooksPanel } from './webhooks-panel';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const QUEUE_LIMIT = 50;

/** Kuyruk öğesi ve zincirdeki job'u: oy kısıtları zincirden okunur, API'nin aynası gecikebilir. */
export interface QueueEntry {
  item: ArbitrationQueueItem;
  job: PublicKey;
  account: JobAccount | null;
}

/**
 * Arbitrator konsolu (FE-17): kuyruk (API), her dispute için kanıtlar, oy durumu ve oy; webhook abonelikleri.
 * Cüzdanın aktif arbitrator olduğu zincirdeki `EscrowConfig`'ten okunur.
 */
export function ArbitrationConsole({ escrowProgramId }: { escrowProgramId: string }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const guard = useNetworkGuard();
  const { apiUrl, cluster } = useWebConfig();
  const session = useApiClient();
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const escrowKey = useMemo(() => new PublicKey(escrowProgramId), [escrowProgramId]);
  const settlementState = useSettlementToken(verified ? escrowProgramId : undefined);
  const token = settlementState.state === 'ready' ? settlementState.token : null;
  const formatAmount = useCallback(
    (base: bigint) => (token ? `${formatUnits(base, token.decimals)} USDC` : base.toString()),
    [token],
  );

  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const chainNow = useChainClock(verified, revision);

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

  const [params, setParams] = useState<Load<DisputeParams>>({ state: 'loading' });
  useEffect(() => {
    if (!escrow) return;
    let active = true;
    escrow.client.escrow.fetch('escrowConfig', escrow.client.pda.escrowConfig()[0]).then(
      (value) =>
        active &&
        setParams(
          value
            ? { state: 'ready', value: disputeParamsOf(value) }
            : { state: 'error', message: 'The escrow config was not found.' },
        ),
      (error: Error) => active && setParams({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, revision]);
  const disputeParams = params.state === 'ready' ? params.value : null;
  const isArbitrator = Boolean(publicKey && disputeParams?.arbitrators.some((key) => key.equals(publicKey)));

  const [queue, setQueue] = useState<Load<QueueEntry[]>>({ state: 'loading' });
  const { api, report } = session;
  useEffect(() => {
    if (!api || !escrow || !isArbitrator) return;
    let active = true;
    (async () => {
      const items = unwrap(await api.getArbitrationQueue({ limit: QUEUE_LIMIT }));
      const jobs = items.map((item) => new PublicKey(item.dispute.job));
      const accounts = await Promise.all(jobs.map((job) => escrow.client.escrow.fetch('job', job)));
      return items.map((item, i) => ({ item, job: jobs[i]!, account: accounts[i] ?? null }));
    })().then(
      (value) => active && setQueue({ state: 'ready', value }),
      (caught: unknown) => active && setQueue({ state: 'error', message: report(caught) }),
    );
    return () => {
      active = false;
    };
  }, [api, escrow, isArbitrator, report, revision]);

  if (!apiUrl) {
    return (
      <Notice>
        The arbitration console needs the Square API, and <span className="font-mono">SQUARE_API_URL</span> is not set.
      </Notice>
    );
  }
  if (!publicKey) return <Notice>Connect an arbitrator wallet to open the console.</Notice>;
  if (!verified) {
    return (
      <Notice>
        {guard.rpc.state === 'checking'
          ? 'Verifying the network before reading the arbitrator set…'
          : 'The network is not verified, so the arbitrator set is not read.'}
      </Notice>
    );
  }
  if (setup.state === 'loading' || (escrow && params.state === 'loading'))
    return <p className="text-sm text-muted">Reading the escrow…</p>;
  if (setup.state === 'error') return <p className="text-sm text-danger-text">{setup.message}</p>;
  if (!escrow) return <p className="text-sm text-muted">The escrow is not initialized on this network yet.</p>;
  if (params.state === 'error') return <p className="text-sm text-danger-text">{params.message}</p>;
  if (!disputeParams) return null;
  if (!isArbitrator) {
    return (
      <Notice>
        This wallet is not in the escrow’s active arbitrator set ({disputeParams.arbitrators.length} members,{' '}
        {disputeParams.threshold} must agree). The escrow admin changes the set with update_arbitrators.
      </Notice>
    );
  }

  return (
    <div className="grid gap-6">
      <section aria-labelledby="panel-heading" className="rounded-card border border-border bg-surface p-6">
        <h2 id="panel-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Panel
        </h2>
        <p className="mt-3 text-sm">
          You are one of {disputeParams.arbitrators.length} arbitrators; {disputeParams.threshold} matching votes decide
          a dispute. The first vote sets the decision, and votes close at the deadline (
          {formatDuration(BigInt(disputeParams.disputeTimeoutSecs))} after the dispute was raised).
        </p>
        <div className="mt-4">
          <ApiSessionPanel session={session} purpose="The dispute queue" />
        </div>
      </section>

      {api && (
        <section aria-labelledby="queue-heading" className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="queue-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
              Open disputes
            </h2>
            <Button variant="ghost" size="sm" onClick={refresh}>
              Refresh
            </Button>
          </div>
          {queue.state === 'loading' && <p className="text-sm text-muted">Reading the queue…</p>}
          {queue.state === 'error' && <p className="text-sm text-danger-text">{queue.message}</p>}
          {queue.state === 'ready' && queue.value.length === 0 && (
            <p className="text-sm text-muted">No open disputes.</p>
          )}
          {queue.state === 'ready' &&
            queue.value.map((entry) => (
              <QueueCard
                key={entry.job.toBase58()}
                entry={entry}
                escrow={escrow}
                escrowKey={escrowKey}
                params={disputeParams}
                arbitrator={publicKey}
                chainNow={chainNow}
                session={session}
                decimals={token?.decimals ?? null}
                formatAmount={formatAmount}
                onConfirmed={refresh}
              />
            ))}
        </section>
      )}

      <WebhooksPanel session={session} allowHttp={cluster === 'localnet'} />
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">{children}</p>;
}

export function QueueCard({
  entry,
  escrow,
  escrowKey,
  params,
  arbitrator,
  chainNow,
  session,
  decimals,
  formatAmount,
  onConfirmed,
}: {
  entry: QueueEntry;
  escrow: EscrowSetup;
  escrowKey: PublicKey;
  params: DisputeParams;
  arbitrator: PublicKey;
  chainNow: number | null;
  session: ApiClientState;
  decimals: number | null;
  formatAmount(base: bigint): string;
  onConfirmed(): void;
}) {
  const { item, job, account } = entry;
  const address = job.toBase58();
  const headingId = `dispute-${address}`;
  if (!account) {
    return (
      <article aria-labelledby={headingId} className="rounded-card border border-border bg-surface p-6 text-sm">
        <h3 id={headingId} className="font-medium">
          <Address value={address} label="job" />
        </h3>
        <p className="mt-2 text-muted">The job is not on chain any more.</p>
      </article>
    );
  }
  const status = Object.keys(account.status)[0]!;
  const facts = disputeFacts(account);
  const tally = voteTally(facts, params);
  const amount = BigInt(account.amount.toString());
  const remaining = chainNow === null ? null : facts.deadline - chainNow;
  // Zincir kuralına API'nin kendi sayımı da eklenir (ör. oy henüz aynaya yansımadıysa `hasVoted`).
  const block =
    voteBlock({ status, facts, disputeParams: params, arbitrator, chainNow }) ??
    (item.hasVoted ? 'You have already voted in the current count.' : null);

  return (
    <article aria-labelledby={headingId} className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="flex flex-wrap items-center gap-2 text-sm font-medium">
          Job <Address value={address} label="job" />
          <Link href={`/app/jobs/${address}`} className="text-link underline">
            Open the job
          </Link>
        </h3>
        {remaining !== null && remaining > 0 ? (
          <span className="font-mono text-caption" role="timer" aria-live="off">
            {formatDuration(BigInt(remaining))} left
          </span>
        ) : (
          <StatusBadge tone="danger">Deadline passed</StatusBadge>
        )}
      </div>
      <dl className="mt-4 grid gap-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-muted">Amount</dt>
          <dd className="font-mono">{formatAmount(amount)}</dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-muted">Challenger</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Address value={facts.challenger.toBase58()} label="challenger" />
            <span className="text-caption text-muted">
              {facts.challenger.equals(account.institution) ? 'the institution' : 'the agent (missing proof)'}
            </span>
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-muted">Bond</dt>
          <dd>{facts.bond > 0n ? formatAmount(facts.bond) : 'None'}</dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-muted">Deadline</dt>
          <dd>
            <time dateTime={iso(facts.deadline)}>{iso(facts.deadline)}</time> (chain time)
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-muted">Votes</dt>
          <dd className="font-mono">
            {tally.approvals} of {tally.threshold}
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-muted">Pending decision</dt>
          <dd>{describeResolution(tally.decision, formatAmount)}</dd>
        </div>
      </dl>
      {tally.stale && (
        <p className="mt-2 text-caption text-muted">
          The arbitrator set changed after the earlier votes; the next vote starts the count again.
        </p>
      )}
      {item.votes.length > 0 && (
        <ol aria-label="Votes" className="mt-3 grid gap-1 text-caption">
          {item.votes.map((vote) => (
            <li key={vote.signature} className="flex flex-wrap items-center gap-2">
              <Address value={vote.arbitrator} label="arbitrator" />
              <span>{describeResolution(vote.resolution, formatAmount)}</span>
              {vote.blockTime !== null && <time dateTime={iso(vote.blockTime)}>{iso(vote.blockTime)}</time>}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-4 grid gap-4 border-t border-border pt-4">
        <EvidencePanel session={session} job={address} canUpload initial={item.evidence} />
        {decimals === null ? (
          <p className="text-sm text-muted">Reading the settlement token…</p>
        ) : (
          <VoteForm
            session={session}
            escrowProgramId={escrowKey}
            config={escrow.client.pda.escrowConfig()[0]}
            arbitrator={arbitrator}
            job={job}
            amount={amount}
            decimals={decimals}
            choices={voteChoices(tally)}
            block={block}
            formatAmount={formatAmount}
            onConfirmed={onConfirmed}
          />
        )}
      </div>
    </article>
  );
}
