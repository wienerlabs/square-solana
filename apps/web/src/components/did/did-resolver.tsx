'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { DidResolutionResult } from '@squaresdk/solana-identity';
import { useNetworkGuard } from '@/components/network-guard';
import { Address, Did } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { CARD_STATUS, RESOLUTION_ERRORS, resolveAgentDid } from '@/lib/did-resolution';
import { AGENT_STATUS_TONE, statusLabel } from '@/lib/status';

type Resolution =
  { state: 'idle' } | { state: 'resolving'; did: string } | { state: 'done'; did: string; result: DidResolutionResult };

/** CAIP-10 hesap kimliğinin (`solana:{ref}:{address}`) adresi. */
const accountOf = (caip10: string) => caip10.slice(caip10.lastIndexOf(':') + 1);

/** did:aip çözümü: DID belgesi ve meta verisi. `initialDid` paylaşılan bağlantıdan (`?did=`) gelir. */
export function DidResolver({ initialDid }: { initialDid: string }) {
  const { connection } = useConnection();
  const guard = useNetworkGuard();
  const inputId = useId();
  const [input, setInput] = useState(initialDid);
  const [resolution, setResolution] = useState<Resolution>({ state: 'idle' });
  const genesisHash = guard.rpc.state === 'ready' ? guard.rpc.genesisHash : null;

  const resolve = useCallback(
    async (did: string) => {
      if (!genesisHash) return;
      setResolution({ state: 'resolving', did });
      const result = await resolveAgentDid(did, connection, genesisHash);
      setResolution({ state: 'done', did, result });
    },
    [connection, genesisHash],
  );

  // Bağlantıyla gelen DID, ağ doğrulanınca bir kez çözülür.
  useEffect(() => {
    if (initialDid && genesisHash && resolution.state === 'idle') void resolve(initialDid);
  }, [initialDid, genesisHash, resolution.state, resolve]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const did = input.trim();
    if (!did) return;
    // Sonuç paylaşılabilir kalsın: adres çubuğu çözülen DID'i taşır.
    window.history.replaceState(null, '', `?did=${encodeURIComponent(did)}`);
    void resolve(did);
  };

  const result = resolution.state === 'done' ? resolution.result : null;
  const error = result?.didResolutionMetadata.error;
  const metadata = result?.didDocumentMetadata;
  const warnings = result?.didResolutionMetadata.warnings ?? [];

  return (
    <div className="grid gap-6">
      <form onSubmit={submit} className="card p-6">
        <label htmlFor={inputId} className="text-sm font-medium">
          did:aip identifier
        </label>
        <div className="mt-2 flex flex-wrap gap-3">
          <input
            id={inputId}
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" loading={resolution.state === 'resolving'} disabled={!genesisHash}>
            Resolve
          </Button>
        </div>
        {guard.rpc.state === 'checking' && <p className="mt-3 text-sm text-muted">Verifying the network…</p>}
        {guard.rpc.state === 'error' && (
          <p className="mt-3 text-sm text-danger-text">The network cannot be verified: {guard.rpc.message}</p>
        )}
      </form>

      {resolution.state === 'done' && error && (
        <section aria-label="Resolution" className="card p-6">
          <StatusBadge tone="danger">{statusLabel(error)}</StatusBadge>
          <p className="mt-3 text-sm">{RESOLUTION_ERRORS[error]}</p>
        </section>
      )}

      {resolution.state === 'done' && result?.didDocument && metadata && (
        <section aria-label="Resolution" className="grid gap-5 card p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Did value={result.didDocument.id} />
            {metadata.agentStatus && (
              <StatusBadge tone={AGENT_STATUS_TONE[metadata.agentStatus]}>
                {statusLabel(metadata.agentStatus)}
              </StatusBadge>
            )}
            {metadata.agentCard && (
              <StatusBadge tone={CARD_STATUS[metadata.agentCard].tone}>
                {CARD_STATUS[metadata.agentCard].label}
              </StatusBadge>
            )}
            {metadata.deprecated && <StatusBadge tone="warning">did:aip v1</StatusBadge>}
          </div>
          <dl className="grid gap-2 text-sm">
            {metadata.owner && (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Owner</dt>
                <dd>
                  <Address value={accountOf(metadata.owner)} label="owner" />
                </dd>
              </div>
            )}
            {metadata.agentWallet && (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Agent wallet</dt>
                <dd>
                  <Address value={accountOf(metadata.agentWallet)} label="agent wallet" />
                </dd>
              </div>
            )}
            {metadata.created && (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Registered</dt>
                <dd>
                  <time dateTime={metadata.created}>{metadata.created}</time>
                </dd>
              </div>
            )}
            {metadata.updated && (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Updated</dt>
                <dd>
                  <time dateTime={metadata.updated}>{metadata.updated}</time>
                </dd>
              </div>
            )}
            {metadata.versionId && (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Read at slot</dt>
                <dd className="font-mono">{metadata.versionId}</dd>
              </div>
            )}
            {metadata.crossRegistrations && (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted">Other registrations</dt>
                <dd>
                  {metadata.crossRegistrations.verified.length} verified,{' '}
                  {metadata.crossRegistrations.unverified.length} unverified
                </dd>
              </div>
            )}
          </dl>
          {result.didDocument.service.length > 0 && (
            <div>
              <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Services</h2>
              <ul className="mt-2 grid gap-1 text-sm">
                {result.didDocument.service.map((service) => (
                  <li key={service.id} className="flex flex-wrap justify-between gap-2">
                    <span>{service.type}</span>
                    <span className="break-all font-mono">{service.serviceEndpoint}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <ul aria-label="Resolution warnings" className="grid gap-1 text-sm text-danger-text">
              {warnings.map((warning) => (
                <li key={warning.code + warning.message}>{warning.message}</li>
              ))}
            </ul>
          )}
          <details>
            <summary className="cursor-pointer text-sm font-medium">DID document</summary>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-muted p-3 font-mono text-caption">
              {JSON.stringify(result.didDocument, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
