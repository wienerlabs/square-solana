'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import type { ClaimListingAccount, JobAccount } from '@squaresdk/solana-sdk';
import type { DeliveryReceipt } from '@squaresdk/solana-types';
import { useApiClient } from '@/components/api-client';
import { useApiSession } from '@/components/api-session';
import { useActor } from '@/components/actor';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { JobClaim } from './job-claim';
import { JobDispute } from './job-dispute';
import { JobPreflight } from './job-preflight';
import { JobRelease } from './job-release';
import { JobSettlement } from './job-settlement';
import { JobTravelRule } from './job-travel-rule';
import { chainRefOf, hex } from '@/lib/agent-registration';
import { payoutOf, type Payout } from '@/lib/claim-market';
import { claimListingAddress } from '@/lib/idl-pda';
import {
  challengeState,
  deliveryHash,
  deliveryUriProblem,
  describeJobEvent,
  JOB_POLL_INTERVAL_MS,
  readJobTimeline,
  readNewestSignature,
  receiptProblem,
  SignatureTracker,
  uploadErrorMessage,
  type TimelineEntry,
} from '@/lib/job-detail';
import { ENV_VARS } from '@/lib/config';
import { escrowErrorMessage, formatDuration, readEscrowSetup, type EscrowSetupLookup } from '@/lib/job-wizard';
import {
  preflightBoundFor,
  readPreflight,
  readReleaseState,
  type PreflightView,
  type ReleaseState,
} from '@/lib/release-proof';
import { sendErrorText } from '@/lib/sponsored-send';
import { formatUnits } from '@/lib/settlement';
import { JOB_STATUS_TONE, statusLabel } from '@/lib/status';
import type { TravelRuleVerification } from '@/lib/travel-rule';
import { useSettlementToken } from '@/lib/use-settlement';
import { useChainClock } from '@/lib/use-chain-clock';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };
type JobStatusName = keyof typeof JOB_STATUS_TONE;

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const statusOf = (job: JobAccount) => Object.keys(job.status)[0] as JobStatusName;

const PAYOUT_TEXT = {
  agent: { label: 'agent wallet', caption: 'the agent wallet' },
  buyer: { label: 'buyer', caption: 'the buyer of the receivable' },
  refunded: { label: 'institution', caption: 'refunded to the institution' },
  cancelled: { label: 'institution', caption: 'cancelled; any locked USDC went back to the institution' },
} as const;
const payoutKey = (payout: Payout): keyof typeof PAYOUT_TEXT =>
  payout.kind === 'institution' ? payout.reason : payout.sold ? 'buyer' : 'agent';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

/**
 * Bir işin zincirdeki durumu, canlı zaman çizelgesi ve challenge sayacı; agent için kabul ve teslim. Rollerin
 * adresi cüzdan ya da rolün smart account vault'udur (FE-21).
 */
export function JobDetail({ jobAddress, escrowProgramId }: { jobAddress: string; escrowProgramId: string }) {
  const { connection } = useConnection();
  const guard = useNetworkGuard();
  const agentActor = useActor('agent');
  const institutionActor = useActor('institution');
  const { apiUrl } = useWebConfig();
  const apiSession = useApiSession();
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

  // Job'u ya da alacak listelemesini anan her işlemde job, listeleme ve zaman çizelgesi yeniden okunur:
  // event'ler canlı. Log aboneliği (WebSocket) anında bildirir; abonelik kurulamaz ya da koparsa iki adresin
  // en yeni imzası birkaç saniyede bir yoklanır.
  const claimKey = useMemo(() => claimListingAddress(escrowKey, jobKey), [escrowKey, jobKey]);
  const watched = useMemo(() => [jobKey, claimKey], [jobKey, claimKey]);
  const seen = useMemo(() => new SignatureTracker(watched.map((address) => address.toBase58())), [watched]);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!verified) return;
    const subscriptions = watched.map((address) =>
      connection.onLogs(
        address,
        ({ signature, err }) => seen.observe(address.toBase58(), signature) && err === null && refresh(),
        'confirmed',
      ),
    );
    return () => {
      for (const subscription of subscriptions) void connection.removeOnLogsListener(subscription);
    };
  }, [verified, connection, watched, seen, refresh]);
  useEffect(() => {
    if (!verified) return;
    let active = true;
    const poll = setInterval(() => {
      if (document.visibilityState === 'hidden' || !seen.known) return;
      Promise.all(watched.map((address) => readNewestSignature(connection, address))).then(
        (newest) => {
          if (!active) return;
          // Her adres ayrı denetlenir: biri değiştiyse yeniden okunur, diğerinin imzası da kaydedilir.
          const changed = newest.map((signature, i) => seen.observe(watched[i]!.toBase58(), signature));
          if (changed.some(Boolean)) refresh();
        },
        () => undefined, // Okunamazsa bir sonraki aralıkta yeniden denenir.
      );
    }, JOB_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [verified, connection, watched, seen, refresh]);

  const [job, setJob] = useState<Load<JobAccount | null>>({ state: 'loading' });
  const [claim, setClaim] = useState<Load<ClaimListingAccount | null>>({ state: 'loading' });
  const [timeline, setTimeline] = useState<Load<TimelineEntry[]>>({ state: 'loading' });
  useEffect(() => {
    if (!escrow) return;
    let active = true;
    escrow.client.escrow.fetch('job', jobKey).then(
      (value) => active && setJob({ state: 'ready', value }),
      (error: Error) => active && setJob({ state: 'error', message: error.message }),
    );
    escrow.client.escrow.fetch('claimListing', claimKey).then(
      (value) => active && setClaim({ state: 'ready', value }),
      (error: Error) => active && setClaim({ state: 'error', message: error.message }),
    );
    readJobTimeline(connection, escrowKey, jobKey, claimKey).then(
      ({ entries, newest }) => {
        if (!active) return;
        seen.baseline(newest);
        setTimeline({ state: 'ready', value: entries });
      },
      (error: Error) => active && setTimeline({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, connection, escrowKey, jobKey, claimKey, seen, revision]);

  // Zincir saati: Clock sysvar'ından okunur, aradaki saniyeler yerel saatle ilerletilir.
  const chainNow = useChainClock(verified, revision);

  const account = job.state === 'ready' ? job.value : null;

  // Politikalı işin ispat durumu: "Compliance proof" bölümü ve finalize paneli aynı okumayı kullanır.
  const [release, setRelease] = useState<Load<ReleaseState>>({ state: 'loading' });
  useEffect(() => {
    if (!escrow || !account?.policy) return;
    let active = true;
    readReleaseState(escrow, jobKey, account).then(
      (value) => active && setRelease({ state: 'ready', value }),
      (error: Error) => active && setRelease({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, jobKey, account, revision]);

  // Kabul öncesi ön-ispat (ADR 0028): policy'li işi agent ancak kurum bağladıktan sonra kabul eder.
  const [preflight, setPreflight] = useState<Load<PreflightView | null>>({ state: 'loading' });
  useEffect(() => {
    if (!escrow || !account?.policy) return;
    let active = true;
    readPreflight(escrow, jobKey).then(
      (value) => active && setPreflight({ state: 'ready', value }),
      (error: Error) => active && setPreflight({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, jobKey, account, revision]);

  // Agent eylemleri: yalnızca job'un agent cüzdanı (rolün adresi).
  const agentKey = agentActor.address;
  const isAgent = Boolean(account && agentKey?.equals(account.agentWallet));
  const institutionKey =
    account && institutionActor.address?.equals(account.institution) ? institutionActor.address : null;
  const apiClient = useApiClient(institutionActor.api);
  const [travelVerification, setTravelVerification] = useState<TravelRuleVerification | null>(null);
  const fileId = useId();
  const uriId = useId();
  const [deliveryUri, setDeliveryUri] = useState('');
  const [content, setContent] = useState<{ file: File; hash: Uint8Array } | null>(null);
  // API'nin makbuzu: teslim URI'si ondan gelir; dosya değişince geçersizdir.
  const [receipt, setReceipt] = useState<DeliveryReceipt | null>(null);
  const [busy, setBusy] = useState<'accept' | 'upload' | 'submit' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);

  const chooseFile = (file: File | undefined) => {
    setActionError(null);
    // Önceki dosyanın makbuzundan gelen URI yeni dosyayı göstermez.
    if (receipt && deliveryUri === receipt.deliveryUri) setDeliveryUri('');
    setReceipt(null);
    if (!file) return setContent(null);
    void file.arrayBuffer().then((buffer) => setContent({ file, hash: deliveryHash(new Uint8Array(buffer)) }));
  };

  // Dosya API'nin deposuna yüklenir (oturumla); makbuzun hash'i tarayıcıdakiyle aynıysa URI'si kullanılır.
  const upload = async () => {
    if (!content) return;
    setBusy('upload');
    setActionError(null);
    try {
      const stored = await apiSession.call(
        (api) => api.uploadDelivery(jobKey.toBase58(), content.file),
        agentActor.api,
      );
      const problem = receiptProblem(stored, content.hash);
      if (problem) {
        setActionError(problem);
        return;
      }
      setReceipt(stored);
      setDeliveryUri(stored.deliveryUri);
    } catch (error) {
      setActionError(uploadErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: 'accept' | 'submit') => {
    if (!escrow || !agentKey) return;
    setBusy(kind);
    setActionError(null);
    try {
      const options = await agentActor.options();
      const built =
        kind === 'accept'
          ? await escrow.client.flow.acceptJob({ agent: agentKey, job: jobKey }, options)
          : await escrow.client.flow.submitWork(
              { agent: agentKey, job: jobKey, workHash: content!.hash, deliveryUri },
              options,
            );
      setSignature(await agentActor.send(built.transaction));
    } catch (error) {
      setActionError(sendErrorText(error, escrowErrorMessage));
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
  const listing = claim.state === 'ready' ? claim.value : null;
  const payout = payoutOf(account, listing);
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
  // Policy'li işte escrow kurumun ön-ispatını ister (ADR 0028); o bağlanmadan kabul gönderilmez.
  const awaitingPreflight =
    account.policy !== null &&
    !(preflight.state === 'ready' && preflightBoundFor(preflight.value, account.agentWallet));
  const preflightForOtherWallet = preflight.state === 'ready' && preflight.value !== null && awaitingPreflight;
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
            <Link href={`/app/agents/${account.agentRecord.toBase58()}`} className="text-link underline">
              Profile
            </Link>
            {did && (
              <Link href={`/app/did?did=${encodeURIComponent(did)}`} className="text-link underline">
                Resolve DID
              </Link>
            )}
          </Row>
          <Row label="Paid to">
            <Address value={payout.wallet.toBase58()} label={PAYOUT_TEXT[payoutKey(payout)].label} />
            <span className="text-caption text-muted">{PAYOUT_TEXT[payoutKey(payout)].caption}</span>
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

      <JobDispute
        escrow={escrow}
        jobKey={jobKey}
        account={account}
        token={token}
        chainNow={chainNow}
        revision={revision}
        formatAmount={formatAmount}
        onConfirmed={refresh}
      />

      <JobTravelRule
        setup={escrow}
        jobAddress={jobAddress}
        job={{
          status: jobStatus,
          amount: BigInt(account.amount.toString()),
          mint: account.mint,
          agentWallet: account.agentWallet,
          commitment: Uint8Array.from(account.travelRuleCommitment),
        }}
        institution={institutionKey}
        api={apiClient}
        verification={travelVerification}
        onVerification={setTravelVerification}
        formatAmount={formatAmount}
        onConfirmed={refresh}
      />

      <JobPreflight
        escrow={escrow}
        jobKey={jobKey}
        account={account}
        preflight={preflight}
        release={release}
        chainNow={chainNow}
      />

      <JobRelease
        escrow={escrow}
        jobKey={jobKey}
        account={account}
        listing={listing}
        release={release}
        chainNow={chainNow}
        formatAmount={formatAmount}
      />

      <JobSettlement
        escrow={escrow}
        jobKey={jobKey}
        account={account}
        listing={listing}
        release={account.policy ? release : null}
        timeline={timeline.state === 'ready' ? timeline.value : null}
        chainNow={chainNow}
        revision={revision}
        token={token}
        formatAmount={formatAmount}
      />

      <JobClaim
        escrow={escrow}
        jobKey={jobKey}
        account={account}
        claim={claim}
        token={token}
        formatAmount={formatAmount}
        chainNow={chainNow}
        revision={revision}
      />

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
                  disabled={!guard.canTransact || busy !== null || pending || awaitingPreflight}
                >
                  Accept the job
                </Button>
                <p className="text-caption text-muted">
                  {preflightForOtherWallet
                    ? "The pre-acceptance proof was bound for another agent wallet; the institution binds it again for this job's wallet before it can be accepted."
                    : awaitingPreflight
                      ? 'The institution has not bound its pre-acceptance proof yet; the job can be accepted after it.'
                      : 'Accepting commits you to deliver before the deadline.'}
                </p>
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
                    onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
                    aria-describedby={`${fileId}-hint`}
                  />
                  <p id={`${fileId}-hint`} className="text-caption text-muted">
                    {apiUrl ? (
                      'Hashed in this browser; only its SHA-256 goes on chain. Upload it to the Square API, which stores it under that hash and gives its URI, or enter where it is hosted.'
                    ) : (
                      <>
                        Hashed in this browser; only its SHA-256 goes on chain. The file is not uploaded here (
                        <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set): enter where it is hosted.
                      </>
                    )}
                  </p>
                  {content && (
                    <p className="text-caption">
                      work_hash of {content.file.name}: <code className="break-all font-mono">{hex(content.hash)}</code>
                    </p>
                  )}
                  {apiUrl && content && !receipt && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="secondary"
                        onClick={() => void upload()}
                        loading={busy === 'upload'}
                        disabled={busy !== null || pending || !beforeDeadline || Boolean(apiSession.unavailable)}
                      >
                        Upload to the Square API
                      </Button>
                      <p className="text-caption text-muted">
                        {apiSession.unavailable ??
                          (apiSession.session
                            ? "The upload uses this wallet's Square API session."
                            : 'Uploading asks this wallet to sign in to the Square API first.')}
                      </p>
                    </div>
                  )}
                  {receipt && deliveryUri === receipt.deliveryUri && (
                    <p className="text-caption">
                      Uploaded {receipt.size.toLocaleString('en-US')} bytes ({receipt.contentType}); the delivery URI
                      below points to it.
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="timeline-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
            Timeline
          </h2>
          <Link href={`/audit/${jobAddress}`} className="text-sm text-link underline">
            Audit trail
          </Link>
        </div>
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
