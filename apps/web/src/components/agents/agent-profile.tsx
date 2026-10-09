'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import type { AgentCard, JobView } from '@squaresdk/solana-types';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address, Did } from '@/components/ui/address';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, type Column } from '@/components/ui/table';
import {
  PROFILE_JOBS_LIMIT,
  readAgentProfile,
  sameNetwork,
  validationHistory,
  type AgentProfile,
} from '@/lib/agent-directory';
import { chainRefOf } from '@/lib/agent-registration';
import { ENV_VARS } from '@/lib/config';
import { VALIDATION_TEXT } from '@/lib/job-settlement';
import { refusalReasons } from '@/lib/release-proof';
import { formatUnits, type SettlementToken } from '@/lib/settlement';
import { squareApi } from '@/lib/square-api';
import { AGENT_STATUS_TONE, JOB_STATUS_TONE, statusLabel, VALIDATION_OUTCOME_TONE } from '@/lib/status';
import { useSettlementToken } from '@/lib/use-settlement';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function Notice({ children }: { children: ReactNode }) {
  return <p className="card p-6 text-sm text-muted">{children}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-6">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

/** Settlement mint'indeki tutar USDC olarak; başka mint'te taban birimi ve mint. */
function Amount({ amount, mint, token }: { amount: string; mint: string; token: SettlementToken | null }) {
  if (token && token.mint.toBase58() === mint) {
    return <span className="font-mono">{formatUnits(BigInt(amount), token.decimals)} USDC</span>;
  }
  return (
    <span className="font-mono">
      {amount} <span className="text-caption text-muted">base units of</span> <Address value={mint} label="mint" />
    </span>
  );
}

/**
 * Agent profili (FE-05): Square API'nin indexer'dan okuduğu kayıt, kart, itibar, validation geçmişi ve işler.
 * Başka ağın ya da registry'nin agent'ı gösterilmez.
 */
export function AgentProfileView({ agentRecord }: { agentRecord: string }) {
  const { apiUrl, programIds } = useWebConfig();
  const guard = useNetworkGuard();
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const genesisHash = guard.rpc.state === 'ready' ? guard.rpc.genesisHash : null;
  const settlement = useSettlementToken(programIds.escrow);
  const token = settlement.state === 'ready' ? settlement.token : null;
  const [profile, setProfile] = useState<Load<AgentProfile | null>>({ state: 'loading' });

  useEffect(() => {
    if (!apiUrl || !verified) return;
    let active = true;
    setProfile({ state: 'loading' });
    readAgentProfile(squareApi(apiUrl), agentRecord).then(
      (value) => active && setProfile({ state: 'ready', value }),
      (error: Error) => active && setProfile({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [apiUrl, verified, agentRecord]);

  if (!apiUrl) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set. The profile is read from the
        Square API, which indexes the agent, its reputation and its jobs.
      </Notice>
    );
  }
  if (!verified || !genesisHash) {
    return (
      <Notice>
        {guard.rpc.state === 'checking'
          ? 'Verifying the network before reading the agent…'
          : 'The network is not verified, so the agent is not read.'}
      </Notice>
    );
  }
  if (profile.state === 'loading') return <p className="text-sm text-muted">Reading the agent…</p>;
  if (profile.state === 'error') {
    return <p className="text-sm text-danger-text">The agent could not be read: {profile.message}</p>;
  }

  const chainRef = chainRefOf(genesisHash);
  if (!profile.value) {
    const did = programIds.registry
      ? squareIdentity.formatDidAip({
          chainRef,
          registry: new PublicKey(programIds.registry),
          agentRecord: new PublicKey(agentRecord),
        })
      : null;
    return (
      <Notice>
        The Square API has no agent at this address; it may not be indexed yet.{' '}
        {did && (
          <Link href={`/app/did?did=${encodeURIComponent(did)}`} className="text-link underline">
            Resolve its DID from the chain
          </Link>
        )}
      </Notice>
    );
  }

  const { agent, jobs, totalJobs } = profile.value;
  if (!sameNetwork(agent, { chainRef, registry: programIds.registry ?? null })) {
    return (
      <Notice>
        The Square API&apos;s record of this agent names another network or registry ({agent.did}), so it is not shown:
        the API may index another cluster.
      </Notice>
    );
  }
  const { account, card, reputation } = agent;
  const history = validationHistory(jobs);

  return (
    <div className="grid gap-6">
      <Section title="Agent">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-subheading font-semibold">{card?.name ?? account.agentId}</h3>
          <StatusBadge tone={AGENT_STATUS_TONE[account.status]}>{statusLabel(account.status)}</StatusBadge>
        </div>
        {card && <p className="mt-2 max-w-3xl text-sm">{card.description}</p>}
        <dl className="mt-4 grid gap-2 text-sm">
          <Row label="DID">
            <Did value={agent.did} />
            <Link href={`/app/did?did=${encodeURIComponent(agent.did)}`} className="text-link underline">
              Resolve DID
            </Link>
          </Row>
          <Row label="Agent id">
            <span className="font-mono">{account.agentId}</span>
          </Row>
          <Row label="Owner">
            <Address value={account.owner} label="owner" />
          </Row>
          <Row label="Payment wallet">
            <Address value={account.wallet} label="wallet" />
          </Row>
          <Row label="Registered">
            <time dateTime={iso(account.registeredAt)}>{iso(account.registeredAt)}</time>
          </Row>
          <Row label="Card">
            <CardState card={card} verified={agent.cardVerified} uri={account.agentCardUri} />
          </Row>
          {card && (
            <Row label="A2A endpoint">
              <span className="break-all font-mono">{card.url}</span>
            </Row>
          )}
          {card?.provider && (
            <Row label="Provider">
              <span>{card.provider.organization}</span>
            </Row>
          )}
        </dl>
        <p className="mt-4 text-caption text-muted">
          Indexed at slot {agent.slot.toLocaleString('en-US')}, {iso(agent.indexedAt)}.
        </p>
      </Section>

      {card && (
        <Section title="Skills and prices">
          <Table
            caption="Skills"
            columns={skillColumns(card, token)}
            rows={card.skills}
            rowKey={(skill) => skill.id}
            empty="The card lists no skill."
          />
        </Section>
      )}

      <Section title="Reputation">
        {reputation ? (
          <>
            <dl className="grid gap-2 text-sm">
              <Row label="Jobs completed">
                <span className="font-mono">{reputation.jobsCompleted}</span>
              </Row>
              <Row label="Jobs failed">
                <span className="font-mono">{reputation.jobsFailed}</span>
              </Row>
              <Row label="Jobs disputed">
                <span className="font-mono">{reputation.jobsDisputed}</span>
              </Row>
              <Row label="Total earned">
                {token ? (
                  <span className="font-mono">{formatUnits(BigInt(reputation.totalEarned), token.decimals)} USDC</span>
                ) : (
                  <span className="font-mono">{reputation.totalEarned}</span>
                )}
              </Row>
              <Row label="First settled job">
                <time dateTime={iso(reputation.firstJobAt)}>{iso(reputation.firstJobAt)}</time>
              </Row>
              <Row label="Last settled job">
                <time dateTime={iso(reputation.lastJobAt)}>{iso(reputation.lastJobAt)}</time>
              </Row>
            </dl>
            <p className="mt-3 text-caption text-muted">
              A release refused by the compliance proof is not counted: its reason is usually the institution&apos;s
              policy, not the agent&apos;s work. The validation history keeps the outcome.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">No settled job yet: the reputation is written at the first settlement.</p>
        )}
      </Section>

      <Section title="Validation history">
        {history.length === 0 ? (
          <p className="text-sm text-muted">No job of this agent is settled yet.</p>
        ) : (
          <ol aria-label="Validation records" className="grid gap-3 text-sm">
            {history.map(({ job, record }) => (
              <li
                key={job}
                className="flex flex-wrap items-center gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                <StatusBadge tone={VALIDATION_OUTCOME_TONE[record.outcome]}>{statusLabel(record.outcome)}</StatusBadge>
                <span>{VALIDATION_TEXT[record.outcome]}</span>
                {record.outcome === 'refused' && (
                  <span className="text-muted">({refusalReasons(record.refusalCode).join('; ')})</span>
                )}
                <time className="text-caption text-muted" dateTime={iso(record.recordedAt)}>
                  {iso(record.recordedAt)}
                </time>
                <Link href={`/app/jobs/${job}`} className="text-link underline">
                  Job {job.slice(0, 4)}…{job.slice(-4)}
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Jobs">
        <Table
          caption="Jobs"
          columns={jobColumns(token)}
          rows={jobs}
          rowKey={(job) => job.address}
          empty="The agent has no job yet."
        />
        {totalJobs > jobs.length && (
          <p className="mt-3 text-caption text-muted">
            The {PROFILE_JOBS_LIMIT} latest of {totalJobs} jobs; the validation history above covers these.
          </p>
        )}
      </Section>
    </div>
  );
}

function CardState({ card, verified, uri }: { card: AgentCard | null; verified: boolean; uri: string }) {
  if (card && verified) return <span>Verified: its SHA-256 matches the registry record</span>;
  if (card)
    return <span className="text-danger-text">The card on the Square API does not match the registry hash</span>;
  if (uri === '') return <span className="text-muted">No card registered</span>;
  return (
    <span className="text-muted">
      Not hosted on the Square API; resolving the DID reads it from <span className="break-all font-mono">{uri}</span>
    </span>
  );
}

function skillColumns(card: AgentCard, token: SettlementToken | null): Column<AgentCard['skills'][number]>[] {
  return [
    {
      key: 'skill',
      header: 'Skill',
      cell: (skill) => (
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{skill.name}</span>
          <span className="text-caption text-muted">{skill.description}</span>
        </span>
      ),
    },
    {
      key: 'tags',
      header: 'Id and tags',
      cell: (skill) => <span className="font-mono text-caption">{[skill.id, ...skill.tags].join(', ')}</span>,
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      cell: (skill) => {
        const prices = (card.pricing ?? []).filter((entry) => entry.skillId === skill.id);
        if (prices.length === 0) return <span className="text-muted">No price</span>;
        return (
          <span className="flex flex-col items-end gap-0.5">
            {prices.map((entry) => (
              <Amount key={entry.mint} amount={entry.amount} mint={entry.mint} token={token} />
            ))}
          </span>
        );
      },
    },
  ];
}

function jobColumns(token: SettlementToken | null): Column<JobView>[] {
  return [
    {
      key: 'job',
      header: 'Job',
      cell: (job) => (
        <Link href={`/app/jobs/${job.address}`} className="font-mono text-link underline">
          {job.address.slice(0, 4)}…{job.address.slice(-4)}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (job) => (
        <StatusBadge tone={JOB_STATUS_TONE[job.account.status]}>{statusLabel(job.account.status)}</StatusBadge>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (job) => <Amount amount={job.account.amount} mint={job.account.mint} token={token} />,
    },
    {
      key: 'institution',
      header: 'Institution',
      cell: (job) => <Address value={job.account.institution} label="institution" />,
    },
    {
      key: 'validation',
      header: 'Validation',
      cell: (job) =>
        job.validation ? (
          <StatusBadge tone={VALIDATION_OUTCOME_TONE[job.validation.outcome]}>
            {statusLabel(job.validation.outcome)}
          </StatusBadge>
        ) : (
          <span className="text-muted">Not settled</span>
        ),
    },
    {
      key: 'opened',
      header: 'Opened',
      cell: (job) => <time dateTime={iso(job.account.createdAt)}>{iso(job.account.createdAt)}</time>,
    },
  ];
}
