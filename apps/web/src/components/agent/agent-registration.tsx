'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { AgentCard } from '@squaresdk/solana-types';
import { useApiSession } from '@/components/api-session';
import { useActor } from '@/components/actor';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
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
  checkHostedCard,
  fetchAndCheckCard,
  hex,
  hostingProblem,
  registryErrorMessage,
  ZERO_HASH,
  type CardCheck,
} from '@/lib/agent-registration';
import { ENV_VARS, isAddress } from '@/lib/config';
import { sendErrorText } from '@/lib/sponsored-send';
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
/** Square API'de barındırılan kart: hangi kayıt girdisi için barındırıldığıyla. */
type HostedCard = { uri: string; hash: Uint8Array; card: AgentCard; registrationKey: string };

/**
 * Agent kaydı (`register_agent`, akışın 2. adımı): sahip ve creator rolün adresidir (cüzdan ya da smart account'un
 * vault'u, FE-21); kart barındırma API'ye rol adına gider.
 */
export function AgentRegistration({ owner, registryProgramId }: { owner: string; registryProgramId: string }) {
  const { connection } = useConnection();
  const guard = useNetworkGuard();
  const actor = useActor('agent');
  const { apiUrl } = useWebConfig();
  const apiSession = useApiSession();
  const ownerKey = useMemo(() => new PublicKey(owner), [owner]);
  const registry = useMemo(() => new PublicKey(registryProgramId), [registryProgramId]);

  const [agentId, setAgentId] = useState('');
  const [cardUri, setCardUri] = useState('');
  const [wallet, setWallet] = useState(owner);
  const [card, setCard] = useState<CardState>({ state: 'idle' });
  const [cardText, setCardText] = useState('');
  const [hosted, setHosted] = useState<HostedCard | null>(null);
  const [hosting, setHosting] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
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

  // Barındırılan kart yalnızca URI'si alanda duruyorsa ve aynı kayıt girdisi içinse geçerli.
  const hostedCard = hosted && hosted.uri === cardUri && hosted.registrationKey === registrationKey ? hosted : null;
  const verified = card.state === 'verified' && card.uri === cardUri ? card : null;
  const cardHash = cardUri === '' ? ZERO_HASH : (hostedCard?.hash ?? verified?.hash ?? null);
  const shownCard = hostedCard?.card ?? verified?.card ?? null;
  const draft = identity && cardText.trim() !== '' ? checkHostedCard(cardText, identity.registration) : null;

  // Kart API'de, oturumla barındırılır (kayıttan önce: `agentId` ile); dönen hash tarayıcıdakiyle aynıysa URI alana gelir.
  const hostCard = async () => {
    if (!identity || draft?.state !== 'ready' || !registrationKey) return;
    setHosting(true);
    setHostError(null);
    try {
      const result = await apiSession.call(
        (api) => api.putAgentCard(identity.agentRecord.toBase58(), draft.card, { agentId }),
        actor.api,
      );
      const problem = hostingProblem(result, draft.hash);
      if (problem) {
        setHostError(problem);
        return;
      }
      setHosted({ uri: result.agentCardUri, hash: draft.hash, card: draft.card, registrationKey });
      setCardUri(result.agentCardUri);
    } catch (error) {
      setHostError((error as Error).message);
    } finally {
      setHosting(false);
    }
  };
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
      const { feePayer } = await actor.options();
      const transaction = await buildRegisterAgentTx(connection, {
        registry,
        payer: feePayer,
        owner: ownerKey,
        agentId,
        agentCardUri: cardUri,
        agentCardHash: cardHash,
        wallet: new PublicKey(wallet),
      });
      setSignature(await actor.send(transaction));
    } catch (error) {
      setSubmitError(sendErrorText(error, registryErrorMessage));
    } finally {
      setSubmitting(false);
    }
  };

  const registered = status?.stage === 'confirmed' || status?.stage === 'finalized';
  const entry = identity ? JSON.stringify(identity.registration, null, 2) : null;

  return (
    <div className="grid gap-6">
      <section aria-labelledby="agent-identity-heading" className="card p-6">
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

      <section aria-labelledby="agent-card-heading" className="card p-6">
        <h2 id="agent-card-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Agent card
        </h2>
        <div className="mt-4 grid gap-5">
          <Field
            label="Agent card URI"
            hint="Publish the card first, at your own address or on the Square API below; its SHA-256 is recorded with the URI. Leave empty to register without a card."
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
          {cardUri !== '' && !uriProblem && !hostedCard && (
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
          {hostedCard && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge tone="success">Hosted on the Square API</StatusBadge>
              The API stores the card under this URI; its SHA-256 matches the one computed here.
            </p>
          )}
          {shownCard && (
            <dl className="grid gap-2 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Name</dt>
                <dd>{shownCard.name}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">A2A endpoint</dt>
                <dd className="font-mono">{shownCard.url}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Skills</dt>
                <dd>{shownCard.skills.map((skill) => skill.name).join(', ')}</dd>
              </div>
            </dl>
          )}
          <div className="grid gap-3 border-t border-border pt-5">
            <h3 className="text-sm font-medium">Host the card on the Square API</h3>
            {!apiUrl ? (
              <p className="text-sm text-muted">
                Unavailable: <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set.
              </p>
            ) : (
              <>
                <Field
                  label="Agent card JSON"
                  hint="The card in the Square agent card schema, with the entry above in its registrations. Hosting signs in to the Square API with this wallet; the API serves the card under its A2A discovery path, and that URI and its SHA-256 are registered."
                  error={draft?.state === 'invalid' ? draft.problems.join(' ') : null}
                >
                  {({ id, describedBy, invalid }) => (
                    <textarea
                      id={id}
                      className={`${inputClass} min-h-40`}
                      value={cardText}
                      onChange={(event) => setCardText(event.target.value)}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      spellCheck={false}
                      disabled={signature !== null || !identity}
                    />
                  )}
                </Field>
                <Field label="Or load the card from a file">
                  {({ id }) => (
                    <input
                      id={id}
                      type="file"
                      accept="application/json,.json"
                      className="text-sm"
                      disabled={signature !== null || !identity}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        if (file) void file.text().then(setCardText);
                      }}
                    />
                  )}
                </Field>
                {!identity && (
                  <p className="text-sm text-muted">Choose the agent ID first: the card names its record.</p>
                )}
                {draft?.state === 'ready' && draft.normalized && (
                  <p className="text-sm text-muted">
                    The hosted card is the card as the schema reads it: fields outside the schema are left out and
                    missing defaults are filled in.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void hostCard()}
                    loading={hosting}
                    disabled={
                      draft?.state !== 'ready' ||
                      lookup?.state !== 'free' ||
                      signature !== null ||
                      Boolean(apiSession.unavailable) ||
                      Boolean(hostedCard)
                    }
                  >
                    Host the card
                  </Button>
                  {apiSession.unavailable && <p className="text-caption text-muted">{apiSession.unavailable}</p>}
                </div>
                {hostError && <p className="text-sm text-danger-text">{hostError}</p>}
              </>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="agent-wallet-heading" className="card p-6">
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

      <section aria-labelledby="agent-onchain-heading" className="card p-6">
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
            <Link href={`/app/agents/${identity.agentRecord.toBase58()}`} className="text-link underline">
              Open the profile
            </Link>{' '}
            or{' '}
            <Link href={`/app/did?did=${encodeURIComponent(identity.did)}`} className="text-link underline">
              resolve the DID
            </Link>
            .
          </p>
        )}
      </section>
    </div>
  );
}
