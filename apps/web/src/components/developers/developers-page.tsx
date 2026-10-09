'use client';

// Geliştirici portalı (FE-22): Square API'sine cüzdan oturumu, API anahtarları, x402 ücretli uç noktalar ve
// kullanımları, SDK örnekleri. API adresi `SQUARE_API_URL`'dir; API'nin `CORS_ORIGINS`'i web'in adresini içermeli.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { ApiKey, X402Endpoint } from '@squaresdk/solana-types';
import type { SquareApi } from '@squaresdk/solana-sdk';
import { useApiClient } from '@/components/api-client';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { ENV_VARS, rpcLabel, type Cluster } from '@/lib/config';
import { formatTime } from '@/lib/developer-portal';
import { unwrap } from '@/lib/square-api';
import { ApiKeysPanel } from './api-keys-panel';
import { ErrorText, headingClass, panelClass } from './field';
import { SnippetsPanel } from './snippets-panel';
import { X402EndpointsPanel } from './x402-endpoints-panel';

function Notice({ children }: { children: ReactNode }) {
  return <p className="card p-6 text-sm text-muted">{children}</p>;
}

function Workspace({
  api,
  apiUrl,
  cluster,
  wallet,
  failed,
}: {
  api: SquareApi;
  apiUrl: string;
  cluster: Cluster;
  wallet: string;
  failed: (error: unknown) => string;
}) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [endpoints, setEndpoints] = useState<X402Endpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [endpointId, setEndpointId] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      setKeys(unwrap(await api.listApiKeys()));
    } catch (cause) {
      setError(failed(cause));
    }
  }, [api, failed]);
  const loadEndpoints = useCallback(async () => {
    try {
      setEndpoints(unwrap(await api.listX402Endpoints()));
    } catch (cause) {
      setError(failed(cause));
    }
  }, [api, failed]);

  useEffect(() => {
    void loadKeys();
    void loadEndpoints();
  }, [loadKeys, loadEndpoints]);

  return (
    <div className="grid gap-6">
      {error && <ErrorText>{error}</ErrorText>}
      <ApiKeysPanel api={api} keys={keys} onChange={loadKeys} failed={failed} />
      <X402EndpointsPanel
        api={api}
        cluster={cluster}
        wallet={wallet}
        endpoints={endpoints}
        selected={endpointId}
        onSelect={setEndpointId}
        onChange={loadEndpoints}
        failed={failed}
      />
      <SnippetsPanel
        apiUrl={apiUrl}
        keys={keys ?? []}
        endpoints={endpoints ?? []}
        keyId={keyId}
        endpointId={endpointId}
        onKey={setKeyId}
        onEndpoint={setEndpointId}
      />
    </div>
  );
}

/** Bağlı cüzdanın portalı; cüzdan ve API adresi verilmiş olmalı. */
export function DeveloperPortal({ apiUrl, cluster, wallet }: { apiUrl: string; cluster: Cluster; wallet: string }) {
  const client = useApiClient();
  const { api, session } = client;
  const problem = api ? null : (client.unavailable ?? client.error);

  return (
    <div className="grid gap-6">
      <section aria-labelledby="api-session-heading" className={panelClass}>
        <h2 id="api-session-heading" className={headingClass}>
          API session
        </h2>
        <p className="mt-2 text-sm text-muted">
          Square API at <span className="font-mono">{rpcLabel(apiUrl)}</span>. Signing a sign-in message proves you own{' '}
          <Address value={wallet} label="wallet" />; it is not a transaction and costs nothing. The session lives only
          in this tab.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {api && session ? (
            <>
              <span className="text-sm">Signed in until {formatTime(session.expiresAt)}</span>
              <Button variant="secondary" size="sm" onClick={() => void client.signOut()}>
                Sign out
              </Button>
            </>
          ) : (
            <Button loading={client.signingIn} onClick={() => void client.signIn()}>
              Sign in with wallet
            </Button>
          )}
        </div>
        {problem && (
          <div className="mt-3">
            <ErrorText>{problem}</ErrorText>
          </div>
        )}
      </section>
      {api && <Workspace api={api} apiUrl={apiUrl} cluster={cluster} wallet={wallet} failed={client.report} />}
    </div>
  );
}

export function DevelopersPage() {
  const { apiUrl, cluster } = useWebConfig();
  const { publicKey } = useWallet();
  if (!apiUrl) {
    return (
      <Notice>
        Unavailable: <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set. API keys and paid endpoints are
        managed through the Square API.
      </Notice>
    );
  }
  if (!publicKey) return <Notice>Connect a wallet to manage its API keys and paid endpoints.</Notice>;
  return <DeveloperPortal apiUrl={apiUrl} cluster={cluster} wallet={publicKey.toBase58()} />;
}
