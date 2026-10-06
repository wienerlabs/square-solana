'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import type { JobAccount } from '@squaresdk/solana-sdk';
import { useApiClient, type ApiClientState } from '@/components/api-client';
import { ApiSessionPanel } from '@/components/api-session-panel';
import { EvidencePanel } from '@/components/dispute/evidence-panel';
import { useNetworkGuard, useSendTransaction } from '@/components/network-guard';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import {
  describeResolution,
  disputeErrorMessage,
  disputeFacts,
  disputeHint,
  disputeParamsOf,
  disputePhase,
  escalationState,
  lapseNotice,
  minimumBond,
  proofSettlesToday,
  raiseState,
  settlementOf,
  voteTally,
  type DisputeFacts,
  type DisputeParams,
  type DisputePhase,
} from '@/lib/dispute';
import { formatDuration, type EscrowSetup } from '@/lib/job-wizard';
import { bytesToHex, hexToBytes } from '@/lib/policy-draft';
import { TransactionBlockedError } from '@/lib/send-transaction';
import { formatUnits, parseUnits, settlementAccount, type SettlementToken } from '@/lib/settlement';
import { unwrap } from '@/lib/square-api';
import { useTokenBalance } from '@/lib/use-settlement';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ZERO_HASH = '0'.repeat(64);

const PHASE_BADGE: Readonly<Record<Exclude<DisputePhase['phase'], 'none'>, { label: string; tone: Tone }>> = {
  open: { label: 'Open for votes', tone: 'warning' },
  expired: { label: 'Deadline passed', tone: 'danger' },
  decided: { label: 'Decided', tone: 'info' },
  lapsed: { label: 'Lapsed', tone: 'neutral' },
  closed: { label: 'Closed', tone: 'success' },
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

/** Bir escrow tx'inin kurulup gönderilmesi; onaylanınca `onConfirmed`. Escrow hatası dispute açıklamasıyla. */
function useEscrowAction(onConfirmed?: () => void) {
  const send = useSendTransaction();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const confirmed = status?.stage === 'confirmed' || status?.stage === 'finalized';
  useEffect(() => {
    if (confirmed) onConfirmed?.();
  }, [confirmed, onConfirmed]);
  const pending = signature !== null && !confirmed && status?.stage !== 'failed';

  const run = useCallback(
    async (kind: string, build: () => Promise<VersionedTransaction>, explain?: (error: unknown) => string | null) => {
      setBusy(kind);
      setError(null);
      try {
        setSignature(await send(await build()));
      } catch (caught) {
        setError(
          caught instanceof TransactionBlockedError
            ? caught.message
            : (explain?.(caught) ?? disputeErrorMessage(caught) ?? (caught as Error).message),
        );
      } finally {
        setBusy(null);
      }
    },
    [send],
  );
  const feedback = (
    <>
      {error && <p className="text-sm text-danger-text">{error}</p>}
      {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
    </>
  );
  return { run, busy, pending, feedback };
}

/**
 * Uyuşmazlık bölümü (FE-17): dispute'un durumu (herkese açık), kurum için itiraz (`raise_dispute`), agent için
 * ispatsız bekleme başvurusu (`escalate_missing_proof`), herkes için kararın ödenmesi (`execute_resolution`) ve
 * son tarihi geçmiş dispute'un düşürülmesi (`lapse_dispute`); taraflara kanıt listesi.
 */
export function JobDispute({
  escrow,
  jobKey,
  account,
  token,
  chainNow,
  revision,
  formatAmount,
  onConfirmed,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  token: SettlementToken | null;
  chainNow: number | null;
  revision: number;
  formatAmount(base: bigint): string;
  onConfirmed?(): void;
}) {
  const { publicKey } = useWallet();
  const guard = useNetworkGuard();
  const session = useApiClient();
  const action = useEscrowAction(onConfirmed);

  // Config her değişiklikte yeniden okunur: arbitrator seti ve eşik oy sayımını belirler.
  const [config, setConfig] = useState<Load<DisputeParams>>({ state: 'loading' });
  useEffect(() => {
    let active = true;
    escrow.client.escrow.fetch('escrowConfig', escrow.client.pda.escrowConfig()[0]).then(
      (value) =>
        active &&
        setConfig(
          value
            ? { state: 'ready', value: disputeParamsOf(value) }
            : { state: 'error', message: 'The escrow config was not found.' },
        ),
      (error: Error) => active && setConfig({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, revision]);
  const params = config.state === 'ready' ? config.value : null;

  const status = Object.keys(account.status)[0]!;
  const facts = disputeFacts(account);
  const phase = disputePhase(facts, status, chainNow);
  const amount = BigInt(account.amount.toString());
  const challengeEnd = account.challengeEnd.toNumber();
  const isInstitution = Boolean(publicKey?.equals(account.institution));
  const isAgent = Boolean(publicKey?.equals(account.agentWallet));
  const isArbitrator = Boolean(publicKey && params?.arbitrators.some((key) => key.equals(publicKey)));
  const hasPolicy = account.policy !== null;

  // Agent'ın başvurusu için bağlı ispat: bugün işi kapatabiliyorsa başvuru gereksiz.
  const watchProof = isAgent && hasPolicy && status === 'delivered';
  // Zincir saati her saniye ilerler; ispat yalnızca job değişince ve UTC günü dönünce yeniden okunur.
  const proofDay = chainNow === null ? null : Math.floor(chainNow / 86_400);
  const [proofSettles, setProofSettles] = useState<Load<boolean>>({ state: 'loading' });
  useEffect(() => {
    if (!watchProof || proofDay === null) return;
    const now = proofDay * 86_400;
    let active = true;
    escrow.client.verifier.fetch('releaseProof', escrow.client.pda.releaseProof(jobKey)[0]).then(
      (proof) =>
        active &&
        setProofSettles({
          state: 'ready',
          value: proofSettlesToday(
            proof && {
              consumed: proof.consumed,
              proofTimestamp: proof.proofTimestamp.toNumber(),
              compliant: 'compliant' in proof.verdict,
              refusalCode: proof.refusalCode,
              dailySpentBefore: BigInt(proof.dailySpentBefore.toString()),
            },
            now,
          ),
        }),
      (error: Error) => active && setProofSettles({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [watchProof, escrow, jobKey, revision, proofDay]);

  const raisable = isInstitution && status === 'delivered' && facts.raisedAt === 0;
  const escalation =
    params && isAgent
      ? escalationState({
          status,
          hasPolicy,
          challengeEnd,
          facts,
          proofTimeoutSecs: params.proofTimeoutSecs,
          chainNow,
          proofSettles: proofSettles.state === 'ready' && proofSettles.value,
        })
      : { state: 'notApplicable' as const };
  if (phase.phase === 'none' && !raisable && escalation.state === 'notApplicable') return null;

  const party = isInstitution || isAgent || isArbitrator;
  const caller = publicKey;
  const tally = params ? voteTally(facts, params) : null;
  const canAct = guard.canTransact && action.busy === null && !action.pending;

  return (
    <section aria-labelledby="dispute-heading" className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="dispute-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Dispute
        </h2>
        {phase.phase !== 'none' && (
          <StatusBadge tone={PHASE_BADGE[phase.phase].tone}>{PHASE_BADGE[phase.phase].label}</StatusBadge>
        )}
      </div>
      {config.state === 'error' && <p className="mt-3 text-sm text-danger-text">{config.message}</p>}

      {phase.phase !== 'none' && (
        <DisputeStatus facts={facts} phase={phase} account={account} tally={tally} formatAmount={formatAmount} />
      )}

      <div className="mt-4 grid gap-4">
        {raisable && (
          <RaiseDispute
            escrow={escrow}
            jobKey={jobKey}
            institution={account.institution}
            amount={amount}
            challengeEnd={challengeEnd}
            facts={facts}
            params={params}
            token={token}
            chainNow={chainNow}
            session={session}
            formatAmount={formatAmount}
            action={action}
            canAct={canAct}
          />
        )}

        {escalation.state !== 'notApplicable' && caller && (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">Missing proof</h3>
            {escalation.state === 'waiting' && (
              <p className="text-sm" role="timer" aria-live="off">
                The institution has not bound a proof that settles the job. You can take it to the arbitrators, without
                a bond, in <span className="font-mono">{formatDuration(BigInt(escalation.remaining))}</span> (at{' '}
                <time dateTime={iso(escalation.readyAt)}>{iso(escalation.readyAt)}</time>, chain time).
              </p>
            )}
            {escalation.state === 'proofSettles' && (
              <p className="text-sm text-muted">
                A proof bound today settles the job (a compliant proof pays, a final refusal refunds): finalize the
                payment instead of escalating.
              </p>
            )}
            {escalation.state === 'blocked' && <p className="text-sm text-muted">{escalation.reason}</p>}
            {escalation.state === 'ready' && (
              <p className="text-sm">
                The proof waiting period has passed and no proof settles the job today. Escalating opens a dispute
                without a bond; the arbitrators decide, and a decision for your side still passes the proof gate.
              </p>
            )}
            <div>
              <Button
                onClick={() =>
                  void action.run('escalate', async () => {
                    const built = await escrow.client.flow.escalateMissingProof(
                      { agent: caller, job: jobKey },
                      { feePayer: caller },
                    );
                    return built.transaction;
                  })
                }
                loading={action.busy === 'escalate'}
                disabled={escalation.state !== 'ready' || !canAct}
              >
                Escalate to the arbitrators
              </Button>
            </div>
          </div>
        )}

        {phase.phase === 'decided' && (
          <ExecuteResolution
            facts={facts}
            amount={amount}
            hasPolicy={hasPolicy}
            formatAmount={formatAmount}
            disabled={!caller || !canAct}
            loading={action.busy === 'execute'}
            onExecute={() =>
              caller &&
              void action.run('execute', async () => {
                const built = await escrow.client.flow.executeResolution({ caller, job: jobKey }, { feePayer: caller });
                return built.transaction;
              })
            }
          />
        )}

        {phase.phase === 'expired' && (
          <div className="grid gap-2" role="alert">
            <p className="text-sm">
              <StatusBadge tone="warning">Can be lapsed</StatusBadge> The deadline passed at{' '}
              <time dateTime={iso(phase.deadline)}>{iso(phase.deadline)}</time> without a decision. Anyone can lapse the
              dispute: the bond goes back to the institution and the job returns to Delivered. The keeper does it too.
            </p>
            <div>
              <Button
                variant="secondary"
                onClick={() =>
                  caller &&
                  void action.run('lapse', async () => {
                    const built = await escrow.client.flow.lapseDispute({ caller, job: jobKey }, { feePayer: caller });
                    return built.transaction;
                  })
                }
                loading={action.busy === 'lapse'}
                disabled={!caller || !canAct}
              >
                Lapse the dispute
              </Button>
            </div>
          </div>
        )}

        {isArbitrator && phase.phase === 'open' && (
          <p className="text-sm">
            You are an arbitrator.{' '}
            <Link href="/app/arbitration" className="text-link underline">
              Vote in the arbitration console
            </Link>
            .
          </p>
        )}

        {(phase.phase === 'decided' || phase.phase === 'expired') && !caller && (
          <p className="text-sm text-muted">Connect a wallet to send the transaction; anyone can.</p>
        )}
        {!guard.canTransact && guard.problems.length > 0 && (
          <p className="text-sm text-danger-text">{guard.problems.join(' ')}</p>
        )}
        {action.feedback}

        {party && phase.phase !== 'none' && (
          <div className="grid gap-3 border-t border-border pt-4">
            <ApiSessionPanel session={session} purpose="Reading the dispute evidence" />
            <EvidencePanel
              session={session}
              job={jobKey.toBase58()}
              canUpload={status === 'disputed' || status === 'resolved'}
              revision={revision}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function DisputeStatus({
  facts,
  phase,
  account,
  tally,
  formatAmount,
}: {
  facts: DisputeFacts;
  phase: DisputePhase;
  account: JobAccount;
  tally: ReturnType<typeof voteTally> | null;
  formatAmount(base: bigint): string;
}) {
  const byInstitution = facts.challenger.equals(account.institution);
  return (
    <>
      <dl className="mt-4 grid gap-2 text-sm">
        <Row label="Challenger">
          <Address value={facts.challenger.toBase58()} label="challenger" />
          <span className="text-caption text-muted">
            {byInstitution ? 'the institution' : 'the agent, escalating a missing proof'}
          </span>
        </Row>
        <Row label="Bond">{facts.bond > 0n ? formatAmount(facts.bond) : 'None'}</Row>
        {facts.reasonHash !== ZERO_HASH && (
          <Row label="reason_hash">
            <code className="break-all font-mono text-caption">{facts.reasonHash}</code>
          </Row>
        )}
        <Row label="Raised">
          <time dateTime={iso(facts.raisedAt)}>{iso(facts.raisedAt)}</time>
        </Row>
        <Row label="Deadline">
          <time dateTime={iso(facts.deadline)}>{iso(facts.deadline)}</time>
          {phase.phase === 'open' && phase.remaining !== null && (
            <span className="font-mono text-caption" role="timer" aria-live="off">
              {formatDuration(BigInt(phase.remaining))} left (chain time)
            </span>
          )}
        </Row>
        {tally && (phase.phase === 'open' || phase.phase === 'expired') && (
          <>
            <Row label="Votes">
              <span className="font-mono">
                {tally.approvals} of {tally.threshold}
              </span>
            </Row>
            <Row label="Pending decision">{describeResolution(tally.decision, formatAmount)}</Row>
          </>
        )}
        {(phase.phase === 'decided' || phase.phase === 'closed') && (
          <Row label="Decision">{describeResolution(facts.resolution, formatAmount)}</Row>
        )}
        {phase.phase === 'decided' && (
          <Row label="Decided at">
            <time dateTime={iso(phase.decidedAt)}>{iso(phase.decidedAt)}</time>
          </Row>
        )}
        {(phase.phase === 'closed' || phase.phase === 'lapsed') && (
          <Row label="Closed">
            <time dateTime={iso(phase.closedAt)}>{iso(phase.closedAt)}</time>
          </Row>
        )}
      </dl>
      {tally?.stale && (phase.phase === 'open' || phase.phase === 'expired') && (
        <p className="mt-3 text-caption text-muted">
          The arbitrator set changed after the earlier votes; they no longer count and the next vote starts the count
          again. The deadline stays the same.
        </p>
      )}
      {phase.phase === 'lapsed' && (
        <p className="mt-3 text-sm" role="note">
          {lapseNotice(facts, formatAmount)}
        </p>
      )}
    </>
  );
}

function ExecuteResolution({
  facts,
  amount,
  hasPolicy,
  formatAmount,
  disabled,
  loading,
  onExecute,
}: {
  facts: DisputeFacts;
  amount: bigint;
  hasPolicy: boolean;
  formatAmount(base: bigint): string;
  disabled: boolean;
  loading: boolean;
  onExecute(): void;
}) {
  const flows = settlementOf(facts.resolution, amount, facts.bond);
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-medium">Pay out the decision</h3>
      <dl className="grid gap-2 text-sm">
        <Row label="To the agent side">{formatAmount(flows.agentSide)}</Row>
        <Row label="Back to the institution">{formatAmount(flows.institutionRefund)}</Row>
        {facts.bond > 0n && (
          <Row label="Bond">
            {flows.bondToAgentSide > 0n
              ? `${formatAmount(flows.bondToAgentSide)} forfeited to the agent side`
              : `${formatAmount(flows.bondReturned)} returned to the institution`}
          </Row>
        )}
      </dl>
      {hasPolicy && flows.agentSide > 0n && (
        <p className="text-caption text-muted">
          The agent side’s amount passes the compliance proof gate: without a fresh compliant proof bound after the
          decision the payment waits (ProofRequired). {disputeHint('ProofRequired')}
        </p>
      )}
      <p className="text-caption text-muted">Anyone can send this; there is no keeper fee on a decision.</p>
      <div>
        <Button onClick={onExecute} loading={loading} disabled={disabled}>
          Execute the resolution
        </Button>
      </div>
    </div>
  );
}

function RaiseDispute({
  escrow,
  jobKey,
  institution,
  amount,
  challengeEnd,
  facts,
  params,
  token,
  chainNow,
  session,
  formatAmount,
  action,
  canAct,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  institution: PublicKey;
  amount: bigint;
  challengeEnd: number;
  facts: DisputeFacts;
  params: DisputeParams | null;
  token: SettlementToken | null;
  chainNow: number | null;
  session: ApiClientState;
  formatAmount(base: bigint): string;
  action: ReturnType<typeof useEscrowAction>;
  canAct: boolean;
}) {
  const fileId = useId();
  const bondId = useId();
  const balance = useTokenBalance(institution, token);
  const minimum = params ? minimumBond(amount, params) : null;
  const [bondText, setBondText] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<{ file: File; hash: string; uploaded: string | null } | null>(null);

  const defaultBond = minimum !== null && token ? formatUnits(minimum, token.decimals, { grouping: false }) : '';
  const shownBond = bondText ?? defaultBond;
  const bond = useMemo(() => {
    if (!token || minimum === null) return null;
    const parsed = parseUnits(shownBond.trim(), token.decimals);
    if (!parsed.ok) return parsed;
    if (parsed.value < minimum) return { ok: false as const, error: `The bond is at least ${formatAmount(minimum)}.` };
    return parsed;
  }, [token, minimum, shownBond, formatAmount]);
  const challengeWindow = raiseState({ status: 'delivered', challengeEnd, facts, chainNow });
  const funds = balance.state === 'ready' ? (balance.amount ?? 0n) : null;
  const short = bond?.ok && funds !== null && funds < bond.value;
  const needsUpload = session.configured;
  const signedIn = Boolean(session.api);

  const raise = () =>
    void action.run('raise', async () => {
      if (!evidence || !bond?.ok || !token) throw new Error('Choose the evidence and the bond first.');
      let reasonHash = evidence.hash;
      if (needsUpload) {
        if (!session.api) throw new Error('Sign in to the Square API to store the evidence first.');
        // Kanıt tx'ten önce saklanır: zincirdeki reason_hash'i arbitrator'lar API'den okur.
        let stored;
        try {
          stored = unwrap(await session.api.uploadDisputeEvidence(jobKey.toBase58(), evidence.file));
        } catch (caught) {
          throw new Error(`The evidence could not be stored: ${session.report(caught)}`, { cause: caught });
        }
        if (stored.reasonHash !== evidence.hash)
          throw new Error('The API stored the evidence under another hash than the file’s SHA-256.');
        reasonHash = stored.reasonHash;
        setEvidence({ ...evidence, uploaded: stored.reasonHash });
      }
      const built = await escrow.client.flow.raiseDispute(
        {
          institution,
          job: jobKey,
          reasonHash: hexToBytes(reasonHash),
          bond: bond.value,
          institutionTokenAccount: settlementAccount(institution, token),
        },
        { feePayer: institution },
      );
      return built.transaction;
    });

  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">Raise a dispute</h3>
      {challengeWindow.ok ? (
        <p className="text-sm" role="timer" aria-live="off">
          The challenge window is open for{' '}
          <span className="font-mono">{formatDuration(BigInt(challengeWindow.remaining))}</span> more (chain time). A
          dispute locks a bond and sends the delivery to the arbitrators
          {params ? ` (${params.threshold} of ${params.arbitrators.length} must agree)` : ''}; without a decision by the
          deadline it lapses and the bond comes back.
        </p>
      ) : (
        <p className="text-sm text-muted">{challengeWindow.reason}</p>
      )}
      {challengeWindow.ok && (
        <>
          {needsUpload && <ApiSessionPanel session={session} purpose="Storing the dispute evidence" />}
          {!needsUpload && (
            <p className="text-caption text-muted">
              The Square API is not configured: only the evidence’s SHA-256 goes on chain, and you share the file with
              the arbitrators yourself.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={fileId} className="text-sm font-medium">
              Evidence file
            </label>
            <input
              id={fileId}
              type="file"
              className="text-sm"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return setEvidence(null);
                void file
                  .arrayBuffer()
                  .then((buffer) =>
                    setEvidence({ file, hash: bytesToHex(sha256(new Uint8Array(buffer))), uploaded: null }),
                  );
              }}
              aria-describedby={`${fileId}-hint`}
            />
            <p id={`${fileId}-hint`} className="text-caption text-muted">
              Its SHA-256 is the dispute’s reason_hash on chain. The file itself is stored privately by the Square API
              for the parties and the arbitrators.
            </p>
            {evidence && (
              <p className="text-caption">
                reason_hash of {evidence.file.name}: <code className="break-all font-mono">{evidence.hash}</code>
                {evidence.uploaded && ' (stored)'}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={bondId} className="text-sm font-medium">
              Bond (USDC)
            </label>
            <input
              id={bondId}
              inputMode="decimal"
              className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
              value={shownBond}
              onChange={(event) => setBondText(event.target.value)}
              aria-invalid={bond !== null && !bond.ok}
              aria-describedby={`${bondId}-hint`}
              autoComplete="off"
            />
            <p id={`${bondId}-hint`} className="text-caption text-muted">
              {minimum !== null && params
                ? `At least ${formatAmount(minimum)}: the larger of ${params.minBondBps / 100}% of the job and ${formatAmount(params.minBondAbsolute)}. Forfeited to the agent if the arbitrators decide for the agent; returned otherwise.`
                : 'Reading the bond rule from the escrow config…'}
            </p>
            {bond && !bond.ok && <p className="text-caption text-danger-text">{bond.error}</p>}
            {short && funds !== null && (
              <p className="text-caption text-danger-text">
                Your USDC balance ({formatAmount(funds)}) is below the bond.
              </p>
            )}
          </div>
          <div>
            <Button
              variant="danger"
              onClick={raise}
              loading={action.busy === 'raise'}
              disabled={!evidence || !bond?.ok || short || (needsUpload && !signedIn) || !canAct}
            >
              Raise the dispute
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
