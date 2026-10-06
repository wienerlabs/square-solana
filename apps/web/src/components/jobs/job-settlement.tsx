'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import type { PublicKey } from '@solana/web3.js';
import type { ClaimListingAccount, JobAccount } from '@squaresdk/solana-sdk';
import type { KeeperAction } from '@squaresdk/solana-types';
import { useNetworkGuard, useSendTransaction } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { payeeOf } from '@/lib/claim-market';
import type { TimelineEntry } from '@/lib/job-detail';
import {
  finalizeErrorMessage,
  finalizeReadiness,
  KEEPER_REASON_TEXT,
  readSettlement,
  settlementEvents,
  VALIDATION_TEXT,
  type FinalizeReadiness,
  type Settlement,
} from '@/lib/job-settlement';
import type { EscrowSetup } from '@/lib/job-wizard';
import { refusalReasons, releaseOutlook, type ReleaseState } from '@/lib/release-proof';
import { TransactionBlockedError } from '@/lib/send-transaction';
import { settlementAccount, type SettlementToken } from '@/lib/settlement';
import { readKeeperJournal, squareApi } from '@/lib/square-api';
import { KEEPER_OUTCOME_TONE, statusLabel, VALIDATION_OUTCOME_TONE } from '@/lib/status';
import { useTokenBalance, type TokenBalance } from '@/lib/use-settlement';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SETTLED = new Set(['released', 'refunded']);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

function Balance({ balance, formatAmount }: { balance: TokenBalance; formatAmount(base: bigint): string }) {
  if (balance.state === 'loading') return <span className="text-muted">Reading…</span>;
  if (balance.state === 'error') return <span className="text-danger-text">{balance.message}</span>;
  return <span className="font-mono">{formatAmount(balance.amount ?? 0n)}</span>;
}

/**
 * Finalize, ödeme ve itibar (FE-10): teslim edilmiş işte herkes finalize'ı tetikleyebilir; ödenmiş ya da iade
 * edilmiş işte ödemenin kime gittiği, keeper ücreti, validation kaydı ve güncel bakiyeler; agent'ın itibarı ve
 * keeper günlüğü.
 */
export function JobSettlement({
  escrow,
  jobKey,
  account,
  listing,
  release,
  timeline,
  chainNow,
  revision,
  token,
  formatAmount,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  listing: ClaimListingAccount | null;
  /** Politikalı işin ispat durumu; politikasız işte null. */
  release: Load<ReleaseState> | null;
  /** Job'un okunan zaman çizelgesi; okunmadıysa null. */
  timeline: readonly TimelineEntry[] | null;
  chainNow: number | null;
  revision: number;
  token: SettlementToken | null;
  formatAmount(base: bigint): string;
}) {
  const status = Object.keys(account.status)[0]!;
  const settled = SETTLED.has(status);
  const events = useMemo(() => settlementEvents(timeline ?? []), [timeline]);
  const payee = events.paid?.payee ?? payeeOf(account, listing).wallet;
  // Bakiyeler hesap değiştikçe güncellenir (onAccountChange): finalize'dan sonra yeni hâlleri.
  const payeeBalance = useTokenBalance(payee, token);
  const institutionBalance = useTokenBalance(account.institution, token);

  const [settlement, setSettlement] = useState<Load<Settlement>>({ state: 'loading' });
  useEffect(() => {
    let active = true;
    readSettlement(escrow, jobKey, account).then(
      (value) => active && setSettlement({ state: 'ready', value }),
      (error: Error) => active && setSettlement({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, jobKey, account, revision]);

  if (status !== 'delivered' && !settled) return null;
  const outlook =
    release?.state === 'ready' && chainNow !== null ? releaseOutlook(release.value, account, listing, chainNow) : null;
  const readiness =
    chainNow === null
      ? null
      : finalizeReadiness({ job: account, chainNow, keeperFeeBps: escrow.keeperFeeBps, release: outlook });
  const sold = listing !== null && payee.equals(listing.buyer);
  const validation = settlement.state === 'ready' ? settlement.value.validation : null;
  const reputation = settlement.state === 'ready' ? settlement.value.reputation : null;

  return (
    <section aria-labelledby="payment-heading" className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="payment-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Payment
        </h2>
        {validation && (
          <StatusBadge tone={VALIDATION_OUTCOME_TONE[validation.outcome]}>
            {statusLabel(validation.outcome)}
          </StatusBadge>
        )}
      </div>

      {status === 'delivered' && (
        <FinalizePanel
          escrow={escrow}
          jobKey={jobKey}
          readiness={readiness}
          release={release}
          token={token}
          formatAmount={formatAmount}
        />
      )}

      {settled && (
        <dl className="mt-4 grid gap-2 text-sm">
          {events.paid && (
            <Row label="Paid">
              <span className="font-mono">{formatAmount(events.paid.net)}</span>
              <span className="text-caption text-muted">to</span>
              <Address value={events.paid.payee.toBase58()} label="payee" />
              <span className="text-caption text-muted">
                {sold ? 'the buyer of the receivable' : 'the agent wallet'}
              </span>
            </Row>
          )}
          {events.refunded && (
            <Row label="Refunded">
              <span className="font-mono">{formatAmount(events.refunded.amount)}</span>
              <span className="text-caption text-muted">
                to the institution: {refusalReasons(events.refunded.refusalCode).join('; ')}
              </span>
            </Row>
          )}
          {events.finalized && (
            <Row label="Finalized by">
              <Address value={events.finalized.keeper.toBase58()} label="keeper" />
              <span className="text-caption text-muted">keeper fee {formatAmount(events.finalized.keeperFee)}</span>
              <Address value={events.finalized.signature} label="signature" />
            </Row>
          )}
          {validation && (
            <Row label="Validation">
              <span>{VALIDATION_TEXT[validation.outcome]}</span>
              <time className="text-caption text-muted" dateTime={iso(validation.recordedAt)}>
                {iso(validation.recordedAt)}
              </time>
            </Row>
          )}
          {timeline && !events.paid && !events.refunded && !events.finalized && (
            <Row label="Settlement">
              <span className="text-muted">
                The settlement transaction is not in this RPC&apos;s recent history; the outcome comes from the
                validation record.
              </span>
            </Row>
          )}
          {settlement.state === 'ready' && !validation && (
            <Row label="Validation">
              <span className="text-muted">No validation record on chain.</span>
            </Row>
          )}
          {events.paid && (
            <Row label={sold ? "Buyer's USDC now" : "Payee's USDC now"}>
              <Balance balance={payeeBalance} formatAmount={formatAmount} />
            </Row>
          )}
          <Row label="Institution's USDC now">
            <Balance balance={institutionBalance} formatAmount={formatAmount} />
          </Row>
        </dl>
      )}
      {settlement.state === 'error' && (
        <p className="mt-3 text-sm text-danger-text">The settlement could not be read: {settlement.message}</p>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-sm font-medium">Agent reputation</h3>
        {settlement.state === 'loading' && <p className="mt-2 text-sm text-muted">Reading the reputation…</p>}
        {settlement.state === 'ready' && !reputation && (
          <p className="mt-2 text-sm text-muted">
            No settled job yet: the reputation is written at the first settlement.
          </p>
        )}
        {reputation && (
          <dl className="mt-2 grid gap-2 text-sm">
            <Row label="Jobs completed">
              <span className="font-mono">{reputation.jobsCompleted.toString()}</span>
            </Row>
            <Row label="Jobs failed">
              <span className="font-mono">{reputation.jobsFailed.toString()}</span>
            </Row>
            <Row label="Jobs disputed">
              <span className="font-mono">{reputation.jobsDisputed.toString()}</span>
            </Row>
            <Row label="Total earned">
              <span className="font-mono">{formatAmount(reputation.totalEarned)}</span>
            </Row>
            <Row label="Last settled job">
              <time dateTime={iso(reputation.lastJobAt)}>{iso(reputation.lastJobAt)}</time>
            </Row>
          </dl>
        )}
        {reputation && (
          <p className="mt-2 text-caption text-muted">
            A release refused by the compliance proof is not counted: its reason is usually the institution&apos;s
            policy, not the agent&apos;s work. The job&apos;s validation record keeps the outcome.
          </p>
        )}
      </div>

      <KeeperJournal job={jobKey.toBase58()} revision={revision} formatAmount={formatAmount} />
    </section>
  );
}

function FinalizePanel({
  escrow,
  jobKey,
  readiness,
  release,
  token,
  formatAmount,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  readiness: FinalizeReadiness | null;
  release: Load<ReleaseState> | null;
  token: SettlementToken | null;
  formatAmount(base: bigint): string;
}) {
  const { publicKey } = useWallet();
  if (release?.state === 'error') {
    return <p className="mt-3 text-sm text-danger-text">The compliance proof could not be read: {release.message}</p>;
  }
  if (!readiness) return <p className="mt-3 text-sm text-muted">Reading the chain clock…</p>;
  if (!readiness.ready) return <p className="mt-3 text-sm">{readiness.reason}</p>;
  return (
    <div className="mt-3 grid gap-3 text-sm">
      <p>
        {readiness.outcome === 'pays'
          ? `Finalizing now pays ${formatAmount(readiness.net)} to the payee.`
          : `Finalizing now refunds ${formatAmount(readiness.net)} to the institution, as the compliance proof decided.`}{' '}
        Anyone can trigger it; the keeper fee of {formatAmount(readiness.keeperFee)} goes to the wallet that does.
      </p>
      {publicKey && token ? (
        <Finalize escrow={escrow} jobKey={jobKey} keeper={publicKey} token={token} />
      ) : (
        <p className="text-muted">Connect a wallet to finalize.</p>
      )}
    </div>
  );
}

function Finalize({
  escrow,
  jobKey,
  keeper,
  token,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  keeper: PublicKey;
  token: SettlementToken;
}) {
  const guard = useNetworkGuard();
  const send = useSendTransaction();
  // Keeper ücreti tetikleyenin USDC hesabına gider; hesap yoksa finalize düşer, önce açılır.
  const keeperAccount = useTokenBalance(keeper, token);
  const [busy, setBusy] = useState<'account' | 'finalize' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const pending =
    signature !== null && status?.stage !== 'confirmed' && status?.stage !== 'finalized' && status?.stage !== 'failed';
  const missing = keeperAccount.state === 'ready' && keeperAccount.amount === null;

  const run = async (kind: 'account' | 'finalize') => {
    setBusy(kind);
    setError(null);
    try {
      const destination = settlementAccount(keeper, token);
      const built =
        kind === 'account'
          ? await escrow.client.buildTx(
              [
                createAssociatedTokenAccountIdempotentInstruction(
                  keeper,
                  destination,
                  keeper,
                  token.mint,
                  token.tokenProgram,
                ),
              ],
              { feePayer: keeper },
            )
          : await escrow.client.flow.finalizePayment(
              { keeper, job: jobKey, keeperTokenAccount: destination },
              { feePayer: keeper },
            );
      setSignature(await send(built.transaction));
    } catch (caught) {
      setError(
        caught instanceof TransactionBlockedError
          ? caught.message
          : (finalizeErrorMessage(caught) ?? (caught as Error).message),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-3">
      {missing && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void run('account')}
            loading={busy === 'account'}
            disabled={!guard.canTransact || busy !== null || pending}
          >
            Create a USDC account
          </Button>
          <p className="text-caption text-muted">
            This wallet has no USDC account to receive the keeper fee; it is opened once, its rent is paid in SOL.
          </p>
        </div>
      )}
      <div>
        <Button
          onClick={() => void run('finalize')}
          loading={busy === 'finalize'}
          disabled={missing || keeperAccount.state !== 'ready' || !guard.canTransact || busy !== null || pending}
        >
          Finalize the payment
        </Button>
      </div>
      {!guard.canTransact && guard.problems.length > 0 && (
        <p className="text-danger-text">{guard.problems.join(' ')}</p>
      )}
      {error && <p className="text-danger-text">{error}</p>}
      {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
    </div>
  );
}

function KeeperJournal({
  job,
  revision,
  formatAmount,
}: {
  job: string;
  revision: number;
  formatAmount(base: bigint): string;
}) {
  const { apiUrl } = useWebConfig();
  const [journal, setJournal] = useState<Load<{ items: KeeperAction[]; total: number }>>({ state: 'loading' });
  useEffect(() => {
    if (!apiUrl) return;
    let active = true;
    readKeeperJournal(squareApi(apiUrl), job).then(
      (value) => active && setJournal({ state: 'ready', value }),
      (error: Error) => active && setJournal({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [apiUrl, job, revision]);

  return (
    <div className="mt-4 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Keeper journal</h3>
      {!apiUrl && (
        <p className="mt-2 text-sm text-muted">
          The keeper&apos;s attempts are read from the Square API, and <span className="font-mono">SQUARE_API_URL</span>{' '}
          is not set.
        </p>
      )}
      {apiUrl && journal.state === 'loading' && <p className="mt-2 text-sm text-muted">Reading the journal…</p>}
      {apiUrl && journal.state === 'error' && (
        <p className="mt-2 text-sm text-danger-text">The keeper journal could not be read: {journal.message}</p>
      )}
      {apiUrl && journal.state === 'ready' && journal.value.items.length === 0 && (
        <p className="mt-2 text-sm text-muted">No keeper attempt is recorded for this job.</p>
      )}
      {apiUrl && journal.state === 'ready' && journal.value.items.length > 0 && (
        <ol aria-label="Keeper attempts" className="mt-2 grid gap-2 text-sm">
          {journal.value.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
              <StatusBadge tone={KEEPER_OUTCOME_TONE[item.outcome]}>{statusLabel(item.outcome)}</StatusBadge>
              <span>{statusLabel(item.action)}</span>
              {item.reason && <span className="text-muted">because {KEEPER_REASON_TEXT[item.reason]}</span>}
              {item.keeperFee !== null && (
                <span className="text-caption text-muted">fee {formatAmount(BigInt(item.keeperFee))}</span>
              )}
              <time className="text-caption text-muted" dateTime={iso(item.at)}>
                {iso(item.at)}
              </time>
              {item.nextAttemptAt !== null && (
                <span className="text-caption text-muted">next attempt {iso(item.nextAttemptAt)}</span>
              )}
              {item.signature && <Address value={item.signature} label="signature" />}
            </li>
          ))}
          {journal.value.total > journal.value.items.length && (
            <li className="text-caption text-muted">
              The {journal.value.items.length} latest of {journal.value.total} attempts.
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
