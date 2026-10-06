'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useNetworkGuard, useSendTransaction } from '@/components/network-guard';
import { Address, Did } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { StatusBadge } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import {
  agentIdentity,
  agentIdProblem,
  buildRegisterAgentTx,
  cardUriProblem,
  fetchAndCheckCard,
  hex,
  registryErrorMessage,
  ZERO_HASH,
  type CardCheck,
} from '@/lib/agent-registration';
import { isAddress } from '@/lib/config';
import { TransactionBlockedError } from '@/lib/send-transaction';
import { useSignatureStatus } from '@/lib/use-signature-status';

const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text aria-invalid:border-danger-text';

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p id={`${id}-hint`} className="text-caption text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-caption text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

type RecordLookup =
  { state: 'checking' } | { state: 'free' } | { state: 'taken' } | { state: 'error'; message: string };
type CardState = { state: 'idle' } | { state: 'checking' } | ({ uri: string } & CardCheck);

/** Bağlı cüzdanın (owner ve creator) agent kaydı: `register_agent`, akışın 2. adımı. */
export function AgentRegistration({ owner, registryProgramId }: { owner: string; registryProgramId: string }) {
  const { connection } = useConnection();
  const guard = useNetworkGuard();
  const send = useSendTransaction();
  const ownerKey = useMemo(() => new PublicKey(owner), [owner]);
  const registry = useMemo(() => new PublicKey(registryProgramId), [registryProgramId]);

  const [agentId, setAgentId] = useState('');
  const [cardUri, setCardUri] = useState('');
  const [wallet, setWallet] = useState(owner);
  const [card, setCard] = useState<CardState>({ state: 'idle' });
  const [lookup, setLookup] = useState<RecordLookup | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);

  const idProblem = agentId === '' ? null : agentIdProblem(agentId);
  const uriProblem = cardUriProblem(cardUri);
  const walletProblem = isAddress(wallet) ? null : 'Enter a Solana address.';
  const genesisHash = guard.rpc.state === 'ready' ? guard.rpc.genesisHash : null;

  // Kayıt adresi ve DID yalnızca geçerli kimlikle ve doğrulanmış ağda (genesis → CAIP-2) hesaplanır.
  const identity = useMemo(
    () =>
      genesisHash && agentId !== '' && !agentIdProblem(agentId)
        ? agentIdentity({ genesisHash, registry, creator: ownerKey, agentId })
        : null,
    [genesisHash, agentId, registry, ownerKey],
  );
  const recordAddress = identity?.agentRecord.toBase58() ?? null;

  useEffect(() => {
    if (!recordAddress) {
      setLookup(null);
      return;
    }
    let active = true;
    setLookup({ state: 'checking' });
    connection.getAccountInfo(new PublicKey(recordAddress)).then(
      (info) => active && setLookup({ state: info ? 'taken' : 'free' }),
      (error: Error) => active && setLookup({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [connection, recordAddress, signature]);

  // Kart doğrulaması bir URI ve bir kayıt girdisi içindir; ikisinden biri değişince yeniden yapılır.
  const registrationKey = identity ? `${identity.registration.agentRegistry}|${identity.registration.agentId}` : null;
  useEffect(() => setCard({ state: 'idle' }), [cardUri, registrationKey]);

  const verifyCard = async () => {
    if (!identity) return;
    const uri = cardUri;
    setCard({ state: 'checking' });
    setCard({ uri, ...(await fetchAndCheckCard(uri, identity.registration)) });
  };

  const verified = card.state === 'verified' && card.uri === cardUri ? card : null;
  const cardHash = cardUri === '' ? ZERO_HASH : (verified?.hash ?? null);
  const ready =
    identity !== null &&
    lookup?.state === 'free' &&
    !uriProblem &&
    !walletProblem &&
    cardHash !== null &&
    guard.canTransact &&
    signature === null;

  const submit = async () => {
    if (!identity || !cardHash) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const transaction = await buildRegisterAgentTx(connection, {
        registry,
        payer: ownerKey,
        owner: ownerKey,
        agentId,
        agentCardUri: cardUri,
        agentCardHash: cardHash,
        wallet: new PublicKey(wallet),
      });
      setSignature(await send(transaction));
    } catch (error) {
      setSubmitError(
        error instanceof TransactionBlockedError
          ? error.message
          : (registryErrorMessage(error) ?? (error as Error).message),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const registered = status?.stage === 'confirmed' || status?.stage === 'finalized';
  const entry = identity ? JSON.stringify(identity.registration, null, 2) : null;

  return (
    <div className="grid gap-6">
      <section aria-labelledby="agent-identity-heading" className="rounded-card border border-border bg-surface p-6">
        <h2 id="agent-identity-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Identity
        </h2>
        <div className="mt-4 grid gap-5">
          <Field
            label="Agent ID"
            hint="Letters, digits, “_” and “-”, at most 32. It never changes and is never reused, even after deregistration."
            error={idProblem}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className={inputClass}
                value={agentId}
                onChange={(event) => setAgentId(event.target.value.trim())}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                disabled={signature !== null}
              />
            )}
          </Field>
          {guard.rpc.state !== 'ready' && (
            <p className="text-sm text-muted">
              {guard.rpc.state === 'checking'
                ? 'Verifying the network before deriving the DID…'
                : `The network cannot be verified: ${guard.rpc.message}`}
            </p>
          )}
          {identity && (
            <dl className="grid gap-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted">DID</dt>
                <dd>
                  <Did value={identity.did} />
                </dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted">Agent record</dt>
                <dd className="flex items-center gap-2">
                  <Address value={identity.agentRecord.toBase58()} label="agent record" />
                  {lookup?.state === 'checking' && <StatusBadge tone="neutral">Checking</StatusBadge>}
                  {lookup?.state === 'free' && <StatusBadge tone="info">Available</StatusBadge>}
                  {lookup?.state === 'taken' && <StatusBadge tone="warning">Already registered</StatusBadge>}
                </dd>
              </div>
            </dl>
          )}
          {lookup?.state === 'taken' && !registered && (
            <p className="text-sm text-muted">
              This wallet already registered “{agentId}”. An agent ID cannot be registered twice.{' '}
              {identity && (
                <>
                  <Link href={`/app/agents/${identity.agentRecord.toBase58()}`} className="text-link underline">
                    Open its profile
                  </Link>{' '}
                  or{' '}
                  <Link href={`/app/did?did=${encodeURIComponent(identity.did)}`} className="text-link underline">
                    resolve its DID
                  </Link>
                  .
                </>
              )}
            </p>
          )}
          {lookup?.state === 'error' && (
            <p className="text-sm text-danger-text">The agent record could not be read: {lookup.message}</p>
          )}
          <p className="text-caption text-muted">
            The DID is computed before the transaction and only exists once the registration is confirmed.
          </p>
        </div>
      </section>

      <section aria-labelledby="agent-card-heading" className="rounded-card border border-border bg-surface p-6">
        <h2 id="agent-card-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Agent card
        </h2>
        <div className="mt-4 grid gap-5">
          <Field
            label="Agent card URI"
            hint="Publish the card first; its SHA-256 is recorded with the URI. Leave empty to register without a card."
            error={uriProblem}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className={inputClass}
                value={cardUri}
                onChange={(event) => setCardUri(event.target.value.trim())}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                disabled={signature !== null}
              />
            )}
          </Field>
          {entry && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Card entry for this agent</p>
                <CopyButton value={entry} label="Copy the registrations entry" />
              </div>
              <p className="text-caption text-muted">
                The card&apos;s <code className="font-mono">registrations</code> list must contain this entry.
              </p>
              <pre className="overflow-x-auto rounded-lg bg-surface-muted p-3 font-mono text-caption">{entry}</pre>
            </div>
          )}
          {cardUri !== '' && !uriProblem && (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void verifyCard()}
                loading={card.state === 'checking'}
                disabled={!identity || signature !== null}
              >
                Fetch and verify the card
              </Button>
              {verified && <StatusBadge tone="success">Verified</StatusBadge>}
            </div>
          )}
          {card.state === 'invalid' && card.uri === cardUri && (
            <ul className="grid gap-1 text-sm text-danger-text" aria-label="Card problems">
              {card.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {verified && (
            <dl className="grid gap-2 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Name</dt>
                <dd>{verified.card.name}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">A2A endpoint</dt>
                <dd className="font-mono">{verified.card.url}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Skills</dt>
                <dd>{verified.card.skills.map((skill) => skill.name).join(', ')}</dd>
              </div>
            </dl>
          )}
        </div>
      </section>

      <section aria-labelledby="agent-wallet-heading" className="rounded-card border border-border bg-surface p-6">
        <h2 id="agent-wallet-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Agent wallet
        </h2>
        <div className="mt-4">
          <Field
            label="Wallet"
            hint="Signs accept, delivery and claim listing, and receives payment. Defaults to this wallet; it can be changed later."
            error={walletProblem}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className={inputClass}
                value={wallet}
                onChange={(event) => setWallet(event.target.value.trim())}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                disabled={signature !== null}
              />
            )}
          </Field>
        </div>
      </section>

      <section aria-labelledby="agent-onchain-heading" className="rounded-card border border-border bg-surface p-6">
        <h2 id="agent-onchain-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          What goes on chain
        </h2>
        <dl className="mt-4 grid gap-2 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-muted">agent_id</dt>
            <dd className="font-mono">{agentId || '—'}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-muted">agent_card_uri</dt>
            <dd className="break-all font-mono">{cardUri || 'empty (no card)'}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-muted">agent_card_hash</dt>
            <dd>
              <code className="break-all font-mono">{cardHash ? hex(cardHash) : 'after the card is verified'}</code>
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-muted">owner, creator, payer</dt>
            <dd>
              <Address value={owner} label="owner" />
            </dd>
          </div>
        </dl>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={() => void submit()} loading={submitting} disabled={!ready || submitting}>
            Register the agent
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
        {registered && identity && (
          <p className="mt-4 text-sm">
            Registered.{' '}
            <Link href={`/app/did?did=${encodeURIComponent(identity.did)}`} className="text-link underline">
              Resolve the DID
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
