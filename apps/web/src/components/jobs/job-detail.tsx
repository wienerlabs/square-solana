'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import type { JobAccount } from '@squaresdk/solana-sdk';
import { useNetworkGuard, useSendTransaction } from '@/components/network-guard';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { chainRefOf, hex } from '@/lib/agent-registration';
import {
  challengeState,
  deliveryHash,
  deliveryUriProblem,
  describeJobEvent,
  JOB_POLL_INTERVAL_MS,
  readChainTime,
  readJobTimeline,
  readNewestSignature,
  SignatureTracker,
  type TimelineEntry,
} from '@/lib/job-detail';
import { escrowErrorMessage, formatDuration, readEscrowSetup, type EscrowSetupLookup } from '@/lib/job-wizard';
import { TransactionBlockedError } from '@/lib/send-transaction';
import { formatUnits } from '@/lib/settlement';
import { JOB_STATUS_TONE, statusLabel } from '@/lib/status';
import { useSettlementToken } from '@/lib/use-settlement';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };
type JobStatusName = keyof typeof JOB_STATUS_TONE;

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const statusOf = (job: JobAccount) => Object.keys(job.status)[0] as JobStatusName;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

/** Bir işin zincirdeki durumu, canlı zaman çizelgesi ve challenge sayacı; agent cüzdanı için kabul ve teslim. */
export function JobDetail({ jobAddress, escrowProgramId }: { jobAddress: string; escrowProgramId: string }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const guard = useNetworkGuard();
  const send = useSendTransaction();
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const genesisHash = guard.rpc.state === 'ready' ? guard.rpc.genesisHash : null;
  const jobKey = useMemo(() => new PublicKey(jobAddress), [jobAddress]);
  const escrowKey = useMemo(() => new PublicKey(escrowProgramId), [escrowProgramId]);
  const settlementState = useSettlementToken(verified ? escrowProgramId : undefined);
  const token = settlementState.state === 'ready' ? settlementState.token : null;
  const formatAmount = (base: bigint) => (token ? `${formatUnits(base, token.decimals)} USDC` : base.toString());

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

  // Job adresini anan her işlemde job ve zaman çizelgesi yeniden okunur: event'ler canlı. Log aboneliği
  // (WebSocket) anında bildirir; abonelik kurulamaz ya da koparsa en yeni imza birkaç saniyede bir yoklanır.
  const [revision, setRevision] = useState(0);
  const seen = useMemo(() => new SignatureTracker(), [jobKey]);
  useEffect(() => {
    if (!verified) return;
    const subscription = connection.onLogs(
      jobKey,
      ({ signature, err }) => seen.observe(signature) && err === null && setRevision((n) => n + 1),
      'confirmed',
    );
    return () => {
      void connection.removeOnLogsListener(subscription);
    };
  }, [verified, connection, jobKey, seen]);
  useEffect(() => {
    if (!verified) return;
    let active = true;
    const poll = setInterval(() => {
      if (document.visibilityState === 'hidden' || !seen.known) return;
      readNewestSignature(connection, jobKey).then(
        (newest) => active && seen.observe(newest) && setRevision((n) => n + 1),
        () => undefined, // Okunamazsa bir sonraki aralıkta yeniden denenir.
      );
    }, JOB_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [verified, connection, jobKey, seen]);

  const [job, setJob] = useState<Load<JobAccount | null>>({ state: 'loading' });
  const [timeline, setTimeline] = useState<Load<TimelineEntry[]>>({ state: 'loading' });
  useEffect(() => {
    if (!escrow) return;
    let active = true;
    escrow.client.escrow.fetch('job', jobKey).then(
      (value) => active && setJob({ state: 'ready', value }),
      (error: Error) => active && setJob({ state: 'error', message: error.message }),
    );
    readJobTimeline(connection, escrowKey, jobKey).then(
      ({ entries, newestSignature }) => {
        if (!active) return;
        seen.baseline(newestSignature);
        setTimeline({ state: 'ready', value: entries });
      },
      (error: Error) => active && setTimeline({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, connection, escrowKey, jobKey, seen, revision]);

  // Zincir saati: Clock sysvar'ından okunur, aradaki saniyeler yerel saatle ilerletilir.
  const [chainOffset, setChainOffset] = useState<number | null>(null);
  const [localNow, setLocalNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!verified) return;
    let active = true;
    const sync = () =>
      readChainTime(connection).then(
        (chainTime) => active && setChainOffset(chainTime - Math.floor(Date.now() / 1000)),
        () => active && setChainOffset(null),
      );
    void sync();
    const resync = setInterval(() => void sync(), 60_000);
    const tick = setInterval(() => setLocalNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => {
      active = false;
      clearInterval(resync);
      clearInterval(tick);
    };
  }, [verified, connection, revision]);
  const chainNow = chainOffset === null ? null : localNow + chainOffset;

  // Agent eylemleri: yalnızca job'un agent cüzdanı.
  const account = job.state === 'ready' ? job.value : null;
  const isAgent = Boolean(account && publicKey?.equals(account.agentWallet));
  const fileId = useId();
  const uriId = useId();
  const [deliveryUri, setDeliveryUri] = useState('');
  const [content, setContent] = useState<{ name: string; hash: Uint8Array } | null>(null);
  const [busy, setBusy] = useState<'accept' | 'submit' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);

  const act = async (kind: 'accept' | 'submit') => {
    if (!escrow || !publicKey) return;
    setBusy(kind);
    setActionError(null);
    try {
      const built =
        kind === 'accept'
          ? await escrow.client.flow.acceptJob({ agent: publicKey, job: jobKey }, { feePayer: publicKey })
          : await escrow.client.flow.submitWork(
              { agent: publicKey, job: jobKey, workHash: content!.hash, deliveryUri },
              { feePayer: publicKey },
            );
      setSignature(await send(built.transaction));
    } catch (error) {
      setActionError(
        error instanceof TransactionBlockedError
          ? error.message
          : (escrowErrorMessage(error) ?? (error as Error).message),
      );
    } finally {
      setBusy(null);
    }
  };

  if (!verified) {
    return (
      <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">
        {guard.rpc.state === 'checking'
          ? 'Verifying the network before reading the job…'
          : 'The network is not verified, so the job is not read.'}
      </p>
    );
  }
  if (setup.state === 'loading' || (escrow && job.state === 'loading'))
    return <p className="text-sm text-muted">Reading the job…</p>;
  if (setup.state === 'error') return <p className="text-sm text-danger-text">{setup.message}</p>;
  if (!escrow) return <p className="text-sm text-muted">The escrow is not initialized on this network yet.</p>;
  if (job.state === 'error')
    return <p className="text-sm text-danger-text">The job could not be read: {job.message}</p>;
  if (!account) return <p className="text-sm text-muted">No job exists at this address.</p>;

  const jobStatus = statusOf(account);
  const challengeEnd = account.challengeEnd.toNumber();
  const challenge = chainNow === null ? null : challengeState(challengeEnd, chainNow);
  const deadline = account.deadline.toNumber();
  const did = genesisHash
    ? squareIdentity.formatDidAip({
        chainRef: chainRefOf(genesisHash),
        registry: escrow.registryProgram,
        agentRecord: account.agentRecord,
      })
    : null;
  const uriProblem = deliveryUri === '' ? null : deliveryUriProblem(deliveryUri);
  const beforeDeadline = chainNow !== null && chainNow < deadline;
  const pending =
    signature !== null && status?.stage !== 'confirmed' && status?.stage !== 'finalized' && status?.stage !== 'failed';

  return (
    <div className="grid gap-6">
      <section aria-labelledby="job-summary" className="rounded-card border border-border bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="job-summary" className="text-sm font-medium uppercase tracking-wide text-muted">
            Job
          </h2>
          <StatusBadge tone={JOB_STATUS_TONE[jobStatus]}>{statusLabel(jobStatus)}</StatusBadge>
        </div>
        <dl className="mt-4 grid gap-2 text-sm">
          <Row label="Account">
            <Address value={jobAddress} label="job" />
          </Row>
          <Row label="Amount">
            <span className="font-mono">{formatAmount(BigInt(account.amount.toString()))}</span>
          </Row>
          <Row label="Institution">
            <Address value={account.institution.toBase58()} label="institution" />
          </Row>
          <Row label="Agent">
            <Address value={account.agentRecord.toBase58()} label="agent record" />
            {did && (
              <Link href={`/app/did?did=${encodeURIComponent(did)}`} className="text-link underline">
                Resolve DID
              </Link>
            )}
          </Row>
          <Row label="Paid to">
            <Address value={account.agentWallet.toBase58()} label="agent wallet" />
          </Row>
          <Row label="Deadline">
            <time dateTime={iso(deadline)}>{iso(deadline)}</time>
          </Row>
          <Row label="Challenge period">{formatDuration(BigInt(account.challengePeriod.toString()))}</Row>
          <Row label="Policy">
            {account.policy ? (
              <>
                <Address value={account.policy.toBase58()} label="policy" />
                <span className="text-caption text-muted">version {account.policyVersion}, proof-gated</span>
              </>
            ) : (
              'None (no proof gate)'
            )}
          </Row>
          <Row label="spec_hash">
            <code className="break-all font-mono text-caption">{hex(Uint8Array.from(account.specHash))}</code>
          </Row>
          {account.deliveryUri !== '' && (
            <>
              <Row label="Delivery">
                <span className="break-all font-mono">{account.deliveryUri}</span>
              </Row>
              <Row label="work_hash">
                <code className="break-all font-mono text-caption">{hex(Uint8Array.from(account.workHash))}</code>
              </Row>
            </>
          )}
        </dl>
      </section>

      {jobStatus === 'delivered' && (
        <section aria-labelledby="challenge-heading" className="rounded-card border border-border bg-surface p-6">
          <h2 id="challenge-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
            Challenge window
          </h2>
          {challenge === null && <p className="mt-3 text-sm text-muted">Reading the chain clock…</p>}
          {challenge?.state === 'open' && (
            <p className="mt-3 text-sm" role="timer" aria-live="off">
              Open for <span className="font-mono">{formatDuration(BigInt(challenge.remaining))}</span> more, until{' '}
              <time dateTime={iso(challenge.endsAt)}>{iso(challenge.endsAt)}</time> (chain time). The institution can
              dispute the delivery until then.
            </p>
          )}
          {challenge?.state === 'closed' && (
            <p className="mt-3 text-sm">
              Closed at <time dateTime={iso(challenge.endsAt)}>{iso(challenge.endsAt)}</time>. Anyone can now finalize
              the payment{account.policy ? ' once the compliance proof is bound' : ''}.
            </p>
          )}
        </section>
      )}

      {isAgent && (jobStatus === 'funded' || jobStatus === 'accepted') && (
        <section aria-labelledby="agent-heading" className="rounded-card border border-border bg-surface p-6">
          <h2 id="agent-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
            Your work
          </h2>
          <div className="mt-4 grid gap-4">
            {jobStatus === 'funded' && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void act('accept')}
                  loading={busy === 'accept'}
                  disabled={!guard.canTransact || busy !== null || pending}
                >
                  Accept the job
                </Button>
                <p className="text-caption text-muted">Accepting commits you to deliver before the deadline.</p>
              </div>
            )}
            {jobStatus === 'accepted' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={fileId} className="text-sm font-medium">
                    Delivery file
                  </label>
                  <input
                    id={fileId}
                    type="file"
                    className="text-sm"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (!file) return setContent(null);
                      void file
                        .arrayBuffer()
                        .then((buffer) => setContent({ name: file.name, hash: deliveryHash(new Uint8Array(buffer)) }));
                    }}
                    aria-describedby={`${fileId}-hint`}
                  />
                  <p id={`${fileId}-hint`} className="text-caption text-muted">
                    Hashed in this browser; only its SHA-256 goes on chain. The file is not uploaded.
                  </p>
                  {content && (
                    <p className="text-caption">
                      work_hash of {content.name}: <code className="break-all font-mono">{hex(content.hash)}</code>
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={uriId} className="text-sm font-medium">
                    Delivery URI
                  </label>
                  <input
                    id={uriId}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
                    value={deliveryUri}
                    onChange={(event) => setDeliveryUri(event.target.value.trim())}
                    aria-invalid={Boolean(uriProblem)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {uriProblem && <p className="text-caption text-danger-text">{uriProblem}</p>}
                </div>
                {!beforeDeadline && chainNow !== null && (
                  <p className="text-sm text-danger-text">
                    The deadline has passed; the work can no longer be delivered.
                  </p>
                )}
                <Button
                  onClick={() => void act('submit')}
                  loading={busy === 'submit'}
                  disabled={
                    !content ||
                    deliveryUri === '' ||
                    Boolean(uriProblem) ||
                    !beforeDeadline ||
                    !guard.canTransact ||
                    busy !== null ||
                    pending
                  }
                >
                  Submit the work
                </Button>
              </>
            )}
            {!guard.canTransact && guard.problems.length > 0 && (
              <p className="text-sm text-danger-text">{guard.problems.join(' ')}</p>
            )}
            {actionError && <p className="text-sm text-danger-text">{actionError}</p>}
            {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
          </div>
        </section>
      )}

      <section aria-labelledby="timeline-heading" className="rounded-card border border-border bg-surface p-6">
        <h2 id="timeline-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Timeline
        </h2>
        {timeline.state === 'loading' && <p className="mt-3 text-sm text-muted">Reading the transactions…</p>}
        {timeline.state === 'error' && (
          <p className="mt-3 text-sm text-danger-text">The timeline could not be read: {timeline.message}</p>
        )}
        {timeline.state === 'ready' && timeline.value.length === 0 && (
          <p className="mt-3 text-sm text-muted">No job events in the recent transactions.</p>
        )}
        {timeline.state === 'ready' && timeline.value.length > 0 && (
          <ol aria-label="Job events" className="mt-3 grid gap-3 text-sm">
            {timeline.value.map((entry, index) => {
              const { title, detail } = describeJobEvent(entry.event, (base) => formatAmount(base));
              return (
                <li key={`${entry.signature}:${index}`} className="grid gap-1 border-l-2 border-border pl-3">
                  <span className="font-medium">{title}</span>
                  {detail && <span className="break-all text-caption text-muted">{detail}</span>}
                  <span className="flex flex-wrap items-center gap-2 text-caption text-muted">
                    {entry.blockTime !== null && <time dateTime={iso(entry.blockTime)}>{iso(entry.blockTime)}</time>}
                    <Address value={entry.signature} label="signature" />
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
