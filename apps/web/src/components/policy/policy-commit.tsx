'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { BuyerTree } from '@squaresdk/solana-policy';
import { useNetworkGuard, useSendTransaction } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import {
  buildPolicyCommitTx,
  COMMIT_STEP_LABEL,
  planPolicyCommit,
  policyErrorMessage,
  readPolicyChain,
  readPolicyHistory,
  type PolicyChainState,
  type PolicyHistoryEntry,
} from '@/lib/policy-chain';
import { institutionAddress, policyAddress } from '@/lib/idl-pda';
import { bytesToHex, hexToBytes } from '@/lib/policy-draft';
import { TransactionBlockedError } from '@/lib/send-transaction';
import { useSignatureStatus } from '@/lib/use-signature-status';
import { BuyerProofs } from './buyer-proofs';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const isoTime = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function Match({ same }: { same: boolean }) {
  return (
    <StatusBadge tone={same ? 'success' : 'warning'}>
      {same ? 'Matches the draft' : 'Differs from the draft'}
    </StatusBadge>
  );
}

interface Props {
  owner: string;
  policyProgramId: string;
  policyId: string;
  /** Taslağın commitment'ı ve alıcı ağacı; kurallar ya da liste geçersizse null. */
  commitment: Uint8Array | null;
  buyerTree: BuyerTree | null;
  /** Public günlük tavan (taban birim); kurallar geçersizse null. */
  dailyCeiling: bigint | null;
  /** Taslak sürümü; zincirdekiyle aynı tutulur (`PolicyDocument.version`). */
  draftVersion: number;
  onChainVersion(version: number): void;
}

/** Taslağı zincire yazar ve zincirdeki politikayı, geçmişiyle, taslakla karşılaştırır. */
export function PolicyCommit(props: Props) {
  const { owner, policyProgramId, policyId, commitment, buyerTree, dailyCeiling, draftVersion, onChainVersion } = props;
  const buyerRoot = buyerTree?.root ?? null;
  const { cluster } = useWebConfig();
  const { connection } = useConnection();
  const guard = useNetworkGuard();
  const send = useSendTransaction();
  const nameId = useId();
  const ownerKey = useMemo(() => new PublicKey(owner), [owner]);
  const programId = useMemo(() => new PublicKey(policyProgramId), [policyProgramId]);

  const [chain, setChain] = useState<Load<PolicyChainState>>({ state: 'loading' });
  const [history, setHistory] = useState<Load<PolicyHistoryEntry[]> | null>(null);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const confirmed = status?.stage === 'confirmed' || status?.stage === 'finalized';
  // Ağ doğrulanmadan hesap okunmaz: yanlış kümede aynı adreste başka bir hesap olabilir.
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;

  useEffect(() => {
    if (!verified) return;
    let active = true;
    setChain({ state: 'loading' });
    readPolicyChain(connection, programId, ownerKey, hexToBytes(policyId)).then(
      (value) => active && setChain({ state: 'ready', value }),
      (error: Error) => active && setChain({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [verified, connection, programId, ownerKey, policyId, confirmed]);

  const onChainPolicy = chain.state === 'ready' ? chain.value.policy : null;
  // Geçmiş, politika hesabına dokunan işlemlerden okunur; hesap zincirde varsa.
  const policyAccount = useMemo(
    () =>
      onChainPolicy
        ? policyAddress(programId, institutionAddress(programId, ownerKey), hexToBytes(policyId)).toBase58()
        : null,
    [onChainPolicy, programId, ownerKey, policyId],
  );

  useEffect(() => {
    if (!policyAccount) {
      setHistory(null);
      return;
    }
    let active = true;
    setHistory({ state: 'loading' });
    readPolicyHistory(connection, programId, new PublicKey(policyAccount)).then(
      (value) => active && setHistory({ state: 'ready', value }),
      (error: Error) => active && setHistory({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [policyAccount, connection, programId, onChainPolicy]);

  // Taslağın sürümü zincirdeki `Policy.version`'ı izler.
  useEffect(() => {
    if (onChainPolicy && onChainPolicy.version !== draftVersion) onChainVersion(onChainPolicy.version);
  }, [onChainPolicy, draftVersion, onChainVersion]);

  const target =
    commitment && buyerRoot && dailyCeiling !== null
      ? { commitment, buyerRoot, dailyCeiling, institutionName: name }
      : null;
  const plan = chain.state === 'ready' && target ? planPolicyCommit(chain.value, target) : null;
  const needsInstitution = chain.state === 'ready' && chain.value.institution === null;

  const submit = async () => {
    if (!target || plan?.state !== 'ready') return;
    setSubmitting(true);
    setSubmitError(null);
    setSignature(null);
    try {
      const transaction = await buildPolicyCommitTx(connection, {
        programId,
        owner: ownerKey,
        policyId: hexToBytes(policyId),
        steps: plan.steps,
        target,
      });
      setSignature(await send(transaction));
    } catch (error) {
      setSubmitError(
        error instanceof TransactionBlockedError
          ? error.message
          : (policyErrorMessage(error) ?? (error as Error).message),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const pending = signature !== null && !confirmed && status?.stage !== 'failed';

  return (
    <section aria-labelledby="commit-heading" className="rounded-card border border-border bg-surface p-6">
      <h2 id="commit-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
        On chain
      </h2>

      {!verified && (
        <p className="mt-3 text-sm text-muted">
          {guard.rpc.state === 'checking'
            ? 'Verifying the network before reading the policy account…'
            : 'The network is not verified, so the policy account is not read and nothing can be committed.'}
        </p>
      )}
      {verified && chain.state === 'loading' && <p className="mt-3 text-sm text-muted">Reading the policy account…</p>}
      {chain.state === 'error' && (
        <p className="mt-3 text-sm text-danger-text">The policy account could not be read: {chain.message}</p>
      )}

      {chain.state === 'ready' && (
        <div className="mt-4 grid gap-4">
          {onChainPolicy ? (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-muted">Status</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={onChainPolicy.active ? 'success' : 'neutral'}>
                  {onChainPolicy.active ? 'Active' : 'Deactivated'}
                </StatusBadge>
                <span>version {onChainPolicy.version}</span>
              </dd>
              <dt className="text-muted">commitment</dt>
              <dd className="flex flex-col gap-1">
                <code className="break-all font-mono text-caption">{bytesToHex(onChainPolicy.commitment)}</code>
                {commitment && <Match same={equal(onChainPolicy.commitment, commitment)} />}
              </dd>
              <dt className="text-muted">daily_ceiling</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{onChainPolicy.dailyCeiling.toString()}</span>
                {dailyCeiling !== null && <Match same={onChainPolicy.dailyCeiling === dailyCeiling} />}
              </dd>
              <dt className="text-muted">buyer_root</dt>
              <dd className="flex flex-col gap-1">
                <code className="break-all font-mono text-caption">{bytesToHex(onChainPolicy.buyerRoot)}</code>
                {buyerRoot && <Match same={equal(onChainPolicy.buyerRoot, buyerRoot)} />}
              </dd>
              <dt className="text-muted">Updated</dt>
              <dd>
                <time dateTime={isoTime(onChainPolicy.updatedAt)}>{isoTime(onChainPolicy.updatedAt)}</time>
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted">This policy is not on chain yet.</p>
          )}

          {onChainPolicy &&
            policyAccount &&
            buyerTree &&
            buyerTree.entries.length > 0 &&
            equal(onChainPolicy.buyerRoot, buyerTree.root) && (
              <BuyerProofs cluster={cluster} policy={policyAccount} tree={buyerTree} />
            )}

          {needsInstitution && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={nameId} className="text-sm font-medium">
                Institution name
              </label>
              <input
                id={nameId}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-describedby={`${nameId}-hint`}
                autoComplete="organization"
                disabled={pending}
              />
              <p id={`${nameId}-hint`} className="text-caption text-muted">
                This wallet has no institution account yet; it is opened in the same transaction. The name is public.
              </p>
            </div>
          )}

          {!target && <p className="text-sm text-muted">Complete the rules and the buyer list to commit.</p>}
          {plan?.state === 'blocked' && <p className="text-sm text-danger-text">{plan.reason}</p>}
          {plan?.state === 'unchanged' && <p className="text-sm">The chain already holds this draft.</p>}
          {plan?.state === 'ready' && (
            <div className="grid gap-2">
              <p className="text-sm font-medium">One transaction, signed by this wallet:</p>
              <ol className="grid list-decimal gap-1 pl-5 font-mono text-caption">
                {plan.steps.map((step) => (
                  <li key={step}>{COMMIT_STEP_LABEL[step]}</li>
                ))}
              </ol>
            </div>
          )}
          {history && (
            <div>
              <h3 className="text-sm font-medium">History</h3>
              {history.state === 'loading' && <p className="mt-2 text-sm text-muted">Reading the transactions…</p>}
              {history.state === 'error' && (
                <p className="mt-2 text-sm text-danger-text">The history could not be read: {history.message}</p>
              )}
              {history.state === 'ready' && history.value.length === 0 && (
                <p className="mt-2 text-sm text-muted">No policy events in the recent transactions.</p>
              )}
              {history.state === 'ready' && history.value.length > 0 && (
                <ol aria-label="Policy history" className="mt-2 grid gap-2 text-sm">
                  {history.value.map((entry, index) => (
                    <li
                      key={`${entry.signature}:${index}`}
                      className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2"
                    >
                      <span>
                        {entry.event.kind === 'committed' && `Committed, version ${entry.event.version}`}
                        {entry.event.kind === 'updated' && `Updated to version ${entry.event.version}`}
                        {entry.event.kind === 'buyerRoot' && 'Buyer root published'}
                        {entry.event.kind === 'deactivated' && 'Deactivated'}
                        {(entry.event.kind === 'committed' || entry.event.kind === 'updated') &&
                          `, ceiling ${entry.event.dailyCeiling.toString()}`}
                      </span>
                      <span className="flex items-center gap-2 text-caption text-muted">
                        {entry.blockTime !== null && (
                          <time dateTime={isoTime(entry.blockTime)}>{isoTime(entry.blockTime)}</time>
                        )}
                        <Address value={entry.signature} label="signature" />
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}

      {/* Düğme ağ doğrulanmadan ve zincir okunmadan da görünür, devre dışı kalır. */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void submit()}
          loading={submitting}
          disabled={plan?.state !== 'ready' || !guard.canTransact || submitting || pending}
        >
          {onChainPolicy ? 'Update on chain' : 'Commit on chain'}
        </Button>
        {!guard.canTransact && guard.problems.length > 0 && (
          <p className="text-sm text-danger-text">{guard.problems.join(' ')}</p>
        )}
      </div>
      {submitError && <p className="mt-3 text-sm text-danger-text">{submitError}</p>}
      {status && (
        <div className="mt-4">
          <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />
        </div>
      )}
    </section>
  );
}
