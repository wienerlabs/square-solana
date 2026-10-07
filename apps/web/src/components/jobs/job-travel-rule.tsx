'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';
import type { TravelRuleStatus as StoredTravelRule } from '@squaresdk/solana-types';
import { useActor } from '@/components/actor';
import type { ApiClientState } from '@/components/api-client';
import { ApiSessionPanel } from '@/components/api-session-panel';
import { useNetworkGuard } from '@/components/network-guard';
import { TravelRuleFormFields } from '@/components/travel-rule/travel-rule-form';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { escrowErrorMessage, type EscrowSetup } from '@/lib/job-wizard';
import { bytesToHex, hexToBytes } from '@/lib/policy-draft';
import { sendErrorText } from '@/lib/sponsored-send';
import { SquareApiError, unwrap } from '@/lib/square-api';
import {
  checkTravelRuleForm,
  emptyTravelRuleForm,
  isBound,
  TRAVEL_RULE_STATUS_TEXT,
  travelRuleStatus,
  verifyDisclosure,
  type TravelRuleStatus,
  type TravelRuleVerification,
} from '@/lib/travel-rule';
import { useSignatureStatus } from '@/lib/use-signature-status';

const STATUS_TONE: Readonly<Record<TravelRuleStatus, Tone>> = {
  notRequired: 'neutral',
  pending: 'warning',
  bound: 'success',
  missing: 'danger',
};

const STATUS_DETAIL: Readonly<Record<TravelRuleStatus, string>> = {
  notRequired: 'The amount is below the Travel Rule threshold; no originator or beneficiary information is needed.',
  pending:
    'The amount is at or above the Travel Rule threshold: the job cannot be funded until the institution binds the commitment of its Travel Rule record.',
  bound:
    'Only this salted commitment is on chain. The Square API keeps the encrypted record and its salt; whoever is granted access (the counterparty VASP, an auditor) recomputes the commitment and compares.',
  missing: 'The amount is at or above the current threshold, but the job has no commitment.',
};

const NO_RECORD = 'The Square API has no Travel Rule record for this job.';

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

export function VerificationResult({ result }: { result: TravelRuleVerification }) {
  switch (result.state) {
    case 'match':
      return (
        <p className="text-sm">
          <StatusBadge tone="success">Matches</StatusBadge> The record stored at{' '}
          <time dateTime={iso(result.storedAt)}>{iso(result.storedAt)}</time> and its salt recompute to the commitment
          on chain. The API keeps it until <time dateTime={iso(result.retainUntil)}>{iso(result.retainUntil)}</time>.
        </p>
      );
    case 'mismatch':
      return (
        <p className="text-sm">
          <StatusBadge tone="danger">Does not match</StatusBadge> The stored record recomputes to{' '}
          <code className="break-all font-mono text-caption">{result.recomputed}</code>.
        </p>
      );
    case 'missing':
      return (
        <p className="text-sm">
          <StatusBadge tone="warning">No record</StatusBadge> {result.reason}
        </p>
      );
  }
}

export interface TravelRuleJob {
  status: string;
  amount: bigint;
  mint: PublicKey;
  agentWallet: PublicKey;
  commitment: Uint8Array;
}

export function JobTravelRule({
  setup,
  jobAddress,
  job,
  institution,
  api,
  verification,
  onVerification,
  formatAmount,
  onConfirmed,
}: {
  setup: EscrowSetup;
  jobAddress: string;
  job: TravelRuleJob;
  institution: PublicKey | null;
  api: ApiClientState;
  verification: TravelRuleVerification | null;
  onVerification(result: TravelRuleVerification | null): void;
  formatAmount(base: bigint): string;
  onConfirmed?(): void;
}) {
  const guard = useNetworkGuard();
  const actor = useActor('institution');
  const jobKey = useMemo(() => new PublicKey(jobAddress), [jobAddress]);
  const status = travelRuleStatus({ ...job, threshold: setup.travelRuleThreshold });
  const bound = isBound(job.commitment);
  const chainHex = bytesToHex(job.commitment);

  const [form, setForm] = useState(emptyTravelRuleForm);
  const [showAll, setShowAll] = useState(false);
  const context = institution && {
    originatorAccount: institution,
    beneficiaryAccount: job.agentWallet,
    amount: job.amount,
    mint: job.mint,
  };
  const checked = context ? checkTravelRuleForm(form, context, new Date().toISOString().slice(0, 10)) : null;

  const [stored, setStored] = useState<StoredTravelRule | null>(null);
  useEffect(() => {
    if (stored && stored.commitment === chainHex) {
      onVerification({ state: 'match', storedAt: stored.storedAt, retainUntil: stored.retainUntil });
    } else {
      onVerification(null);
    }
  }, [chainHex, stored, onVerification]);

  const [busy, setBusy] = useState<'store' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const tx = useSignatureStatus(signature);
  const confirmed = tx?.stage === 'confirmed' || tx?.stage === 'finalized';
  useEffect(() => {
    if (confirmed) onConfirmed?.();
  }, [confirmed, onConfirmed]);
  const pending = signature !== null && !confirmed && tx?.stage !== 'failed';

  const signedIn = api.api !== null;
  const canBind =
    institution !== null &&
    job.status === 'open' &&
    signedIn &&
    guard.canTransact &&
    !pending &&
    busy === null &&
    (checked?.ok || !showAll);

  const bind = async () => {
    setShowAll(true);
    if (!institution || !checked?.ok || !api.api) return;
    setBusy('store');
    setError(null);
    try {
      const saved = unwrap(await api.api.putTravelRule(jobAddress, { record: checked.record }));
      setStored(saved);
      const built = await setup.client.flow.commitTravelRule(
        { institution, job: jobKey, commitment: hexToBytes(saved.commitment) },
        await actor.options(),
      );
      setSignature(await actor.send(built.transaction));
    } catch (caught) {
      setError(caught instanceof SquareApiError ? api.report(caught) : sendErrorText(caught, escrowErrorMessage));
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (!api.api) return;
    setBusy('verify');
    setError(null);
    try {
      onVerification(verifyDisclosure(jobKey, unwrap(await api.api.getTravelRule(jobAddress)), job.commitment));
    } catch (caught) {
      if (caught instanceof SquareApiError && caught.code === 'not_found') {
        onVerification({ state: 'missing', reason: `${NO_RECORD} ${caught.apiMessage}` });
      } else {
        setError(api.report(caught));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="travel-rule-heading" className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="travel-rule-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Travel Rule
        </h2>
        <StatusBadge tone={STATUS_TONE[status]}>{TRAVEL_RULE_STATUS_TEXT[status]}</StatusBadge>
      </div>
      <dl className="mt-4 grid gap-2 text-sm">
        <Row label="Threshold">
          {setup.travelRuleThreshold > 0n ? `${formatAmount(setup.travelRuleThreshold)} and above` : 'Off'}
        </Row>
        <Row label="Commitment">
          {bound ? <code className="break-all font-mono text-caption">{chainHex}</code> : 'None'}
        </Row>
      </dl>
      <p className="mt-3 text-sm text-muted">{STATUS_DETAIL[status]}</p>

      {institution && checked && (
        <div className="mt-4 grid gap-4">
          {!api.configured ? (
            <p className="text-sm text-muted">
              The Travel Rule record is stored encrypted by the Square API, and SQUARE_API_URL is not set: the record
              cannot be stored or checked here.
            </p>
          ) : (
            <ApiSessionPanel session={api} purpose="Storing and checking the Travel Rule record" />
          )}
          {bound && api.configured && (
            <div className="grid gap-2">
              <div>
                <Button
                  variant="secondary"
                  onClick={() => void verify()}
                  loading={busy === 'verify'}
                  disabled={!signedIn || busy !== null}
                >
                  Check against the stored record
                </Button>
              </div>
              <p className="text-caption text-muted">
                Reads the record and its salt from the Square API (the read is logged) and recomputes the commitment in
                this browser.
              </p>
              {verification && <VerificationResult result={verification} />}
            </div>
          )}
          {job.status === 'open' && status !== 'notRequired' && api.configured && (
            <div className="grid gap-4">
              <TravelRuleFormFields
                value={form}
                onChange={setForm}
                errors={checked.ok ? {} : checked.errors}
                showAll={showAll}
                accounts={{ originator: institution.toBase58(), beneficiary: job.agentWallet.toBase58() }}
                disabled={busy !== null || pending}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void bind()} loading={busy === 'store'} disabled={!canBind}>
                  {bound ? 'Store a new record and bind it' : 'Store the record and bind the commitment'}
                </Button>
              </div>
              <p className="text-caption text-muted">
                The Square API encrypts the record, draws a fresh salt and returns the commitment; commit_travel_rule
                puts only the commitment on chain. It can be replaced until the job is funded.
              </p>
              {!guard.canTransact && guard.problems.length > 0 && (
                <p className="text-sm text-danger-text">{guard.problems.join(' ')}</p>
              )}
            </div>
          )}
          {error && <p className="text-sm text-danger-text">{error}</p>}
          {tx && <TxConfirmation stage={tx.stage} signature={signature ?? undefined} error={tx.error} />}
        </div>
      )}
    </section>
  );
}
