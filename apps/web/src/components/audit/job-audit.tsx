'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { JobAccount } from '@squaresdk/solana-sdk';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { StatusBadge } from '@/components/ui/status-badge';
import { hex } from '@/lib/agent-registration';
import { ENV_VARS, PROGRAM_ID_ENV } from '@/lib/config';
import { claimListingAddress } from '@/lib/idl-pda';
import { explorerTxUrl, proofHistory, readAuditEvents, type AuditEvents } from '@/lib/job-audit';
import { describeJobEvent, readJobTimeline, TIMELINE_LIMIT, type TimelineEntry } from '@/lib/job-detail';
import { readSettlement, VALIDATION_TEXT, type Settlement } from '@/lib/job-settlement';
import { readEscrowSetup, type EscrowSetup } from '@/lib/job-wizard';
import { readReleaseState, refusalReasons, type ReleaseState } from '@/lib/release-proof';
import { formatUnits } from '@/lib/settlement';
import { squareApi } from '@/lib/square-api';
import { JOB_STATUS_TONE, RELEASE_VERDICT_TONE, statusLabel, VALIDATION_OUTCOME_TONE } from '@/lib/status';
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

/** Job'un zincirdeki hâli, ispatı ve validation kaydı; politikasız işte ispat yoktur. */
interface ChainState {
  setup: EscrowSetup;
  job: JobAccount;
  release: ReleaseState | null;
  settlement: Settlement;
}

/** Denetim sayfası: escrow yapılandırılmamışsa açılmaz. */
export function JobAuditPage({ jobAddress }: { jobAddress: string }) {
  const { programIds } = useWebConfig();
  if (!programIds.escrow) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{PROGRAM_ID_ENV.escrow}</span> is not set. Jobs live in the
        square_escrow program.
      </Notice>
    );
  }
  return <JobAudit jobAddress={jobAddress} escrowProgramId={programIds.escrow} />;
}

/**
 * Job'un herkese açık uyum geçmişi (FE-12): zincirdeki job, ispatın kararı ve geçmişi, bütün event'ler ve
 * işlemleri. Politikanın kuralları gösterilmez; zincirde yalnızca commitment'ları vardır.
 */
function JobAudit({ jobAddress, escrowProgramId }: { jobAddress: string; escrowProgramId: string }) {
  const { connection } = useConnection();
  const { cluster, rpcUrl, apiUrl } = useWebConfig();
  const guard = useNetworkGuard();
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const jobKey = useMemo(() => new PublicKey(jobAddress), [jobAddress]);
  const escrowKey = useMemo(() => new PublicKey(escrowProgramId), [escrowProgramId]);
  const settlementToken = useSettlementToken(verified ? escrowProgramId : undefined);
  const token = settlementToken.state === 'ready' ? settlementToken.token : null;
  const formatAmount = (base: bigint) => (token ? `${formatUnits(base, token.decimals)} USDC` : `${base} base units`);

  const [chain, setChain] = useState<Load<ChainState | null>>({ state: 'loading' });
  useEffect(() => {
    if (!verified) return;
    let active = true;
    (async () => {
      const lookup = await readEscrowSetup(connection, escrowKey);
      if (lookup.state !== 'ready') throw new Error('The escrow is not initialized on this network yet.');
      const job = await lookup.setup.client.escrow.fetch('job', jobKey);
      if (!job) return null;
      const [release, settlement] = await Promise.all([
        job.policy ? readReleaseState(lookup.setup, jobKey, job) : null,
        readSettlement(lookup.setup, jobKey, job),
      ]);
      return { setup: lookup.setup, job, release, settlement };
    })().then(
      (value) => active && setChain({ state: 'ready', value }),
      (error: Error) => active && setChain({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [verified, connection, escrowKey, jobKey]);

  // Bütün geçmiş indexer'dan (API); API yoksa RPC'nin son işlemlerinden (yalnızca escrow event'leri).
  const [events, setEvents] = useState<Load<AuditEvents & { source: 'api' | 'rpc' }>>({ state: 'loading' });
  useEffect(() => {
    if (!verified) return;
    let active = true;
    const read = apiUrl
      ? readAuditEvents(squareApi(apiUrl), jobAddress).then((value) => ({ ...value, source: 'api' as const }))
      : readJobTimeline(connection, escrowKey, jobKey, claimListingAddress(escrowKey, jobKey)).then(({ entries }) => ({
          entries,
          total: entries.length,
          source: 'rpc' as const,
        }));
    read.then(
      (value) => active && setEvents({ state: 'ready', value }),
      (error: Error) => active && setEvents({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [verified, apiUrl, connection, escrowKey, jobKey, jobAddress]);

  if (!verified) {
    return (
      <Notice>
        {guard.rpc.state === 'checking'
          ? 'Verifying the network before reading the job…'
          : 'The network is not verified, so the job is not read.'}
      </Notice>
    );
  }
  if (chain.state === 'loading') return <p className="text-sm text-muted">Reading the job…</p>;
  if (chain.state === 'error')
    return <p className="text-sm text-danger-text">The job could not be read: {chain.message}</p>;
  if (!chain.value) return <Notice>No job exists at this address.</Notice>;

  const { job, release, settlement } = chain.value;
  const status = Object.keys(job.status)[0]!;
  const proof = release?.proof ?? null;
  const validation = settlement.validation;
  const entries = events.state === 'ready' ? events.value.entries : null;
  const history = entries ? proofHistory(entries) : null;
  const txLink = (signature: string) => (
    <a
      href={explorerTxUrl(signature, cluster, rpcUrl)}
      target="_blank"
      rel="noreferrer"
      className="text-link underline"
    >
      Explorer
    </a>
  );

  return (
    <div className="grid gap-6">
      <Section title="Job">
        <dl className="grid gap-2 text-sm">
          <Row label="Status">
            <StatusBadge tone={JOB_STATUS_TONE[status as keyof typeof JOB_STATUS_TONE]}>
              {statusLabel(status)}
            </StatusBadge>
            <Link href={`/app/jobs/${jobAddress}`} className="text-link underline">
              Job page
            </Link>
          </Row>
          <Row label="Account">
            <Address value={jobAddress} label="job" />
          </Row>
          <Row label="Amount">
            <span className="font-mono">{formatAmount(BigInt(job.amount.toString()))}</span>
          </Row>
          <Row label="Institution">
            <Address value={job.institution.toBase58()} label="institution" />
          </Row>
          <Row label="Agent">
            <Address value={job.agentRecord.toBase58()} label="agent record" />
            <Link href={`/app/agents/${job.agentRecord.toBase58()}`} className="text-link underline">
              Profile
            </Link>
          </Row>
          <Row label="Opened">
            <time dateTime={iso(job.createdAt.toNumber())}>{iso(job.createdAt.toNumber())}</time>
          </Row>
          {job.settledAt.toNumber() > 0 && (
            <Row label="Settled">
              <time dateTime={iso(job.settledAt.toNumber())}>{iso(job.settledAt.toNumber())}</time>
            </Row>
          )}
          <Row label="Policy">
            {job.policy ? (
              <>
                <Address value={job.policy.toBase58()} label="policy" />
                <span className="text-caption text-muted">version {job.policyVersion}</span>
              </>
            ) : (
              <span>None: no compliance proof gates the release</span>
            )}
          </Row>
          {job.policy && (
            <Row label="Policy commitment">
              <code className="break-all font-mono text-caption">{hex(Uint8Array.from(job.policyCommitment))}</code>
            </Row>
          )}
        </dl>
        {job.policy && (
          <p className="mt-3 text-caption text-muted">
            The policy&apos;s rules are private: the chain keeps only their commitment, and this page shows only what
            the compliance proof decided.
          </p>
        )}
      </Section>

      <Section title="Compliance decision">
        {!job.policy && (
          <p className="text-sm">No proof gate: the escrow pays the payee once the challenge window closes.</p>
        )}
        {job.policy && !proof && <p className="text-sm">No compliance proof is bound to this job yet.</p>}
        {proof && (
          <dl className="grid gap-2 text-sm">
            <Row label="Decision">
              <StatusBadge tone={RELEASE_VERDICT_TONE[proof.compliant ? 'compliant' : 'refused']}>
                {proof.compliant ? 'Compliant' : 'Refused'}
              </StatusBadge>
              {!proof.compliant && <span className="text-muted">{refusalReasons(proof.refusalCode).join('; ')}</span>}
            </Row>
            <Row label="Proved at">
              <time dateTime={iso(proof.proofTimestamp)}>{iso(proof.proofTimestamp)}</time>
            </Row>
            <Row label="Payee">
              <Address value={proof.payee.toBase58()} label="payee" />
            </Row>
            <Row label="Net amount">
              <span className="font-mono">{formatAmount(proof.netAmount)}</span>
            </Row>
            <Row label="Use">
              <span>{proof.consumed ? 'Used by the release' : 'Bound, not used by a release yet'}</span>
            </Row>
          </dl>
        )}
        {validation && (
          <dl className="mt-4 grid gap-2 border-t border-border pt-4 text-sm">
            <Row label="Validation">
              <StatusBadge tone={VALIDATION_OUTCOME_TONE[validation.outcome]}>
                {statusLabel(validation.outcome)}
              </StatusBadge>
              <span>{VALIDATION_TEXT[validation.outcome]}</span>
            </Row>
            <Row label="Recorded">
              <time dateTime={iso(validation.recordedAt)}>{iso(validation.recordedAt)}</time>
            </Row>
          </dl>
        )}
        {job.policy && history && history.length > 0 && (
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="text-sm font-medium">Proofs bound to this job</h3>
            <ol aria-label="Proof history" className="mt-2 grid gap-2 text-sm">
              {history.map((decision) => (
                <li key={decision.signature} className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={RELEASE_VERDICT_TONE[decision.compliant ? 'compliant' : 'refused']}>
                    {decision.compliant ? 'Compliant' : 'Refused'}
                  </StatusBadge>
                  {!decision.compliant && (
                    <span className="text-muted">{refusalReasons(decision.refusalCode).join('; ')}</span>
                  )}
                  {decision.blockTime !== null && (
                    <time className="text-caption text-muted" dateTime={iso(decision.blockTime)}>
                      {iso(decision.blockTime)}
                    </time>
                  )}
                  {txLink(decision.signature)}
                </li>
              ))}
            </ol>
          </div>
        )}
        {job.policy && events.state === 'ready' && events.value.source === 'rpc' && (
          <p className="mt-3 text-caption text-muted">
            Earlier proofs are listed when the events come from the Square API (
            <span className="font-mono">{ENV_VARS.apiUrl}</span>).
          </p>
        )}
      </Section>

      <Section title="Events">
        {events.state === 'loading' && <p className="text-sm text-muted">Reading the events…</p>}
        {events.state === 'error' && (
          <p className="text-sm text-danger-text">The events could not be read: {events.message}</p>
        )}
        {events.state === 'ready' && (
          <>
            <p className="text-caption text-muted">
              {events.value.source === 'api' ? (
                events.value.total > events.value.entries.length ? (
                  `The first ${events.value.entries.length} of ${events.value.total} events, from the Square API's index.`
                ) : (
                  `All ${events.value.total} events of the job, from the Square API's index of the escrow and verifier programs.`
                )
              ) : (
                <>
                  Escrow events in the RPC&apos;s last {TIMELINE_LIMIT} transactions of the job. The full history, with
                  the verifier&apos;s proof records, comes from the Square API (
                  <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set).
                </>
              )}
            </p>
            {events.value.entries.length === 0 ? (
              <p className="mt-3 text-sm text-muted">No events.</p>
            ) : (
              <ol aria-label="Job events" className="mt-3 grid gap-3 text-sm">
                {events.value.entries.map((entry: TimelineEntry, index) => {
                  const { title, detail } = describeJobEvent(entry.event, formatAmount);
                  return (
                    <li key={`${entry.signature}:${index}`} className="grid gap-1 border-l-2 border-border pl-3">
                      <span className="font-medium">{title}</span>
                      {detail && <span className="break-all text-caption text-muted">{detail}</span>}
                      <span className="flex flex-wrap items-center gap-2 text-caption text-muted">
                        {entry.blockTime !== null && (
                          <time dateTime={iso(entry.blockTime)}>{iso(entry.blockTime)}</time>
                        )}
                        <span>slot {entry.slot.toLocaleString('en-US')}</span>
                        <Address value={entry.signature} label="signature" />
                        {txLink(entry.signature)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
