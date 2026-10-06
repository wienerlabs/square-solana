'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useNetworkGuard, useSendTransaction } from '@/components/network-guard';
import { TravelRuleFormFields } from '@/components/travel-rule/travel-rule-form';
import { TravelRuleVaultPanel } from '@/components/travel-rule/vault-panel';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { escrowErrorMessage, type EscrowSetup } from '@/lib/job-wizard';
import { bytesToHex, hexToBytes } from '@/lib/policy-draft';
import { TransactionBlockedError } from '@/lib/send-transaction';
import {
  buildTravelRuleRecord,
  checkTravelRuleForm,
  createTravelRuleEntry,
  emptyTravelRuleForm,
  isBound,
  TRAVEL_RULE_STATUS_TEXT,
  travelRuleStatus,
  verifyTravelRule,
  type TravelRuleStatus,
  type TravelRuleVerification,
} from '@/lib/travel-rule';
import type { TravelRuleVault } from '@/lib/use-travel-rule-vault';
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
    'Only this salted commitment is on chain. Whoever holds the record and its salt (the counterparty VASP, an auditor) recomputes it and compares.',
  missing: 'The amount is at or above the current threshold, but the job has no commitment.',
};

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
          <StatusBadge tone="success">Matches</StatusBadge> Your record of{' '}
          <time dateTime={iso(result.entry.createdAt)}>{iso(result.entry.createdAt)}</time> and its salt recompute to
          the commitment on chain.
        </p>
      );
    case 'mismatch':
      return (
        <p className="text-sm">
          <StatusBadge tone="danger">Does not match</StatusBadge> Your latest record for this job recomputes to{' '}
          <code className="break-all font-mono text-caption">{result.local}</code>.
        </p>
      );
    case 'noRecord':
      return (
        <p className="text-sm">
          <StatusBadge tone="warning">No record</StatusBadge> This browser&apos;s store has no record for this job.
        </p>
      );
    case 'notBound':
      return <p className="text-sm text-muted">No commitment is bound to compare with.</p>;
  }
}

export interface TravelRuleJob {
  status: string;
  amount: bigint;
  mint: PublicKey;
  agentWallet: PublicKey;
  commitment: Uint8Array;
}

/**
 * İşin Travel Rule durumu (herkese açık) ve işi açan kurum için kayıt, commitment'ın bağlanması
 * (`commit_travel_rule`, yalnızca `Open` işte) ve yerel kayıtla doğrulama.
 */
export function JobTravelRule({
  setup,
  jobAddress,
  job,
  institution,
  vault,
  formatAmount,
  onConfirmed,
}: {
  setup: EscrowSetup;
  jobAddress: string;
  job: TravelRuleJob;
  /** Bağlı cüzdan işi açan kurumsa onun adresi; değilse null (yalnızca durum görünür). */
  institution: PublicKey | null;
  vault: TravelRuleVault;
  formatAmount(base: bigint): string;
  onConfirmed?(): void;
}) {
  const guard = useNetworkGuard();
  const send = useSendTransaction();
  const jobKey = useMemo(() => new PublicKey(jobAddress), [jobAddress]);
  const status = travelRuleStatus({ ...job, threshold: setup.travelRuleThreshold });
  const bound = isBound(job.commitment);
  const chainHex = bytesToHex(job.commitment);

  const [form, setForm] = useState(emptyTravelRuleForm);
  const [showAll, setShowAll] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const checked = checkTravelRuleForm(form, today);

  const [verification, setVerification] = useState<{ commitment: string; result: TravelRuleVerification } | null>(null);
  const shownVerification = verification?.commitment === chainHex && vault.unlocked ? verification.result : null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const tx = useSignatureStatus(signature);
  const confirmed = tx?.stage === 'confirmed' || tx?.stage === 'finalized';
  useEffect(() => {
    if (confirmed) onConfirmed?.();
  }, [confirmed, onConfirmed]);
  const pending = signature !== null && !confirmed && tx?.stage !== 'failed';

  const canBind =
    institution !== null &&
    job.status === 'open' &&
    vault.unlocked &&
    guard.canTransact &&
    !pending &&
    !busy &&
    (checked.ok || !showAll);

  // Kayıt önce şifreli depoya yazılır, sonra commitment'ı zincire gönderilir: tx onaylanıp kayıt
  // kaybolursa iş, kimsenin doğrulayamayacağı bir commitment'la fonlanırdı.
  const bind = async () => {
    setShowAll(true);
    if (!institution || !checked.ok) return;
    setBusy(true);
    setError(null);
    try {
      const record = buildTravelRuleRecord(checked.value, {
        originatorAccount: institution,
        beneficiaryAccount: job.agentWallet,
        amount: job.amount,
        asset: job.mint,
      });
      const entry = createTravelRuleEntry({ job: jobKey, record, now: Math.floor(Date.now() / 1000) });
      await vault.add(entry);
      const built = await setup.client.flow.commitTravelRule(
        { institution, job: jobKey, commitment: hexToBytes(entry.commitment) },
        { feePayer: institution },
      );
      setSignature(await send(built.transaction));
    } catch (err) {
      setError(
        err instanceof TransactionBlockedError ? err.message : (escrowErrorMessage(err) ?? (err as Error).message),
      );
    } finally {
      setBusy(false);
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

      {institution && (
        <div className="mt-4 grid gap-4">
          <TravelRuleVaultPanel vault={vault} />
          {bound && (
            <div className="grid gap-2">
              <div>
                <Button
                  variant="secondary"
                  onClick={() =>
                    setVerification({
                      commitment: chainHex,
                      result: verifyTravelRule(vault.entries, jobAddress, job.commitment),
                    })
                  }
                  disabled={!vault.unlocked}
                >
                  Verify with the local record
                </Button>
              </div>
              {!vault.unlocked && (
                <p className="text-caption text-muted">Unlock the records to recompute the commitment.</p>
              )}
              {shownVerification && <VerificationResult result={shownVerification} />}
            </div>
          )}
          {job.status === 'open' && status !== 'notRequired' && (
            <div className="grid gap-4">
              <TravelRuleFormFields
                value={form}
                onChange={setForm}
                errors={checked.ok ? {} : checked.errors}
                showAll={showAll}
                accounts={{ originator: institution.toBase58(), beneficiary: job.agentWallet.toBase58() }}
                disabled={busy || pending}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void bind()} loading={busy} disabled={!canBind}>
                  {bound ? 'Bind a new commitment' : 'Bind the Travel Rule commitment'}
                </Button>
                {!vault.unlocked && (
                  <p className="text-sm text-muted">
                    Create or unlock the encrypted store first: the record is saved there before the transaction.
                  </p>
                )}
              </div>
              <p className="text-caption text-muted">
                A fresh 32-byte salt is drawn and the record is encrypted in this browser; commit_travel_rule puts only
                the commitment on chain. It can be replaced until the job is funded.
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
