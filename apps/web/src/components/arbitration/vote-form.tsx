'use client';

import { useEffect, useId, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { PublicKey } from '@solana/web3.js';
import { useNetworkGuard, useSendTransaction } from '@/components/network-guard';
import { Button } from '@/components/ui/button';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { unwrap, type ApiSessionState } from '@/lib/api-session';
import {
  decodeUnsignedTransaction,
  parseSplitAmount,
  readLookupTables,
  voteRequest,
  voteTransactionProblem,
} from '@/lib/arbitration';
import {
  describeResolution,
  disputeErrorMessage,
  disputeHint,
  RESOLUTION_LABEL,
  type DisputeResolution,
  type VoteChoices,
} from '@/lib/dispute';
import { TransactionBlockedError } from '@/lib/send-transaction';
import { formatUnits } from '@/lib/settlement';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Choice = Exclude<DisputeResolution['kind'], 'pending'>;
const CHOICES: readonly Choice[] = ['favorAgent', 'favorInstitution', 'split'];

/**
 * Oy: karar seçilir, API imzasız `resolve_dispute` tx'ini hazırlar, tx çözülüp seçimle karşılaştırılır,
 * cüzdana imzalatılıp gönderilir. İlk oy kararı belirlediyse yalnızca o karar seçilebilir; `block` varsa
 * (son tarih geçti, oy verildi, aktif arbitrator değil) oy kapalıdır.
 */
export function VoteForm({
  session,
  escrowProgramId,
  config,
  arbitrator,
  job,
  amount,
  decimals,
  choices,
  block,
  formatAmount,
  onConfirmed,
}: {
  session: ApiSessionState;
  escrowProgramId: PublicKey;
  config: PublicKey;
  arbitrator: PublicKey;
  job: PublicKey;
  amount: bigint;
  decimals: number;
  choices: VoteChoices;
  block: string | null;
  formatAmount(base: bigint): string;
  onConfirmed(): void;
}) {
  const { connection } = useConnection();
  const guard = useNetworkGuard();
  const send = useSendTransaction();
  const name = useId();
  const splitId = useId();
  const fixed = choices.kind === 'fixed' ? choices.resolution : null;
  const [choice, setChoice] = useState<Choice | null>(null);
  const [splitText, setSplitText] = useState('');
  const shownChoice = (fixed?.kind as Choice | undefined) ?? choice;
  const shownSplit =
    fixed?.kind === 'split' ? formatUnits(BigInt(fixed.agentAmount), decimals, { grouping: false }) : splitText;
  const split = shownChoice === 'split' ? parseSplitAmount(shownSplit, decimals, amount) : null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const confirmed = status?.stage === 'confirmed' || status?.stage === 'finalized';
  useEffect(() => {
    if (confirmed) onConfirmed();
  }, [confirmed, onConfirmed]);
  const pending = signature !== null && !confirmed && status?.stage !== 'failed';

  const resolution: DisputeResolution | null =
    shownChoice === null
      ? null
      : shownChoice === 'split'
        ? split?.ok
          ? { kind: 'split', agentAmount: split.value.toString() }
          : null
        : { kind: shownChoice };

  const vote = async () => {
    if (!resolution || !session.api) return;
    setBusy(true);
    setError(null);
    try {
      let prepared;
      try {
        prepared = unwrap(await session.api.prepareDisputeVote(job.toBase58(), voteRequest(resolution)));
      } catch (caught) {
        setError(session.report(caught, disputeHint));
        return;
      }
      const transaction = decodeUnsignedTransaction(prepared.transaction);
      const problem = voteTransactionProblem(
        transaction,
        { escrowProgramId, config, arbitrator, job, resolution },
        await readLookupTables(connection, transaction),
      );
      if (problem) {
        setError(`The API’s transaction was not signed: ${problem}`);
        return;
      }
      setSignature(await send(transaction));
    } catch (caught) {
      setError(
        caught instanceof TransactionBlockedError
          ? caught.message
          : (disputeErrorMessage(caught) ?? (caught as Error).message),
      );
    } finally {
      setBusy(false);
    }
  };

  const closed = block !== null || !session.api;
  return (
    <div className="grid gap-3">
      <fieldset disabled={closed || busy || pending} className="grid gap-2">
        <legend className="text-sm font-medium">Your vote</legend>
        {fixed && (
          <p className="text-caption text-muted">
            The first vote set the decision ({describeResolution(fixed, formatAmount)}); a vote must match it.
          </p>
        )}
        {CHOICES.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={name}
              value={option}
              checked={shownChoice === option}
              disabled={fixed !== null && fixed.kind !== option}
              onChange={() => setChoice(option)}
              className="accent-accent"
            />
            {RESOLUTION_LABEL[option]}
          </label>
        ))}
        {shownChoice === 'split' && (
          <div className="flex flex-col gap-1.5 pl-6">
            <label htmlFor={splitId} className="text-sm">
              Agent’s share (USDC), of {formatAmount(amount)}
            </label>
            <input
              id={splitId}
              inputMode="decimal"
              className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
              value={shownSplit}
              readOnly={fixed !== null}
              onChange={(event) => setSplitText(event.target.value)}
              aria-invalid={split !== null && !split.ok && shownSplit !== ''}
              autoComplete="off"
            />
            {split && !split.ok && shownSplit !== '' && <p className="text-caption text-danger-text">{split.error}</p>}
            {split?.ok && (
              <p className="text-caption text-muted">
                The rest, {formatAmount(amount - split.value)}, goes back to the institution.
              </p>
            )}
          </div>
        )}
      </fieldset>
      {block && <p className="text-sm text-muted">{block}</p>}
      <div>
        <Button
          onClick={() => void vote()}
          loading={busy}
          disabled={closed || !resolution || !guard.canTransact || pending}
        >
          Vote
        </Button>
      </div>
      {error && <p className="text-sm text-danger-text">{error}</p>}
      {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
    </div>
  );
}
