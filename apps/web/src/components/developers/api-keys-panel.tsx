'use client';

// API anahtarları (FE-22): liste (son kullanım dahil), oluşturma (etiket ve kapsamlar) ve iptal. Gizli değer
// yalnızca oluşturma yanıtında gelir; bir kez gösterilir, kopyalanır ve kapatılınca sayfadan da silinir.
import { useState } from 'react';
import type { ApiKey, ApiKeyCreated, ApiKeyScope } from '@squaresdk/solana-types';
import type { SquareApi } from '@squaresdk/solana-sdk';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Table, type Column } from '@/components/ui/table';
import { API_KEY_SCOPES, SCOPE_INFO, formatTime } from '@/lib/developer-portal';
import { unwrap } from '@/lib/square-api';
import { ErrorText, Field, headingClass, inputClass, panelClass } from './field';

export function ApiKeysPanel({
  api,
  keys,
  onChange,
  failed,
}: {
  api: SquareApi;
  /** Yüklenmediyse null. */
  keys: readonly ApiKey[] | null;
  /** Listeyi yeniden okur. */
  onChange: () => Promise<void>;
  failed: (error: unknown) => string;
}) {
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<ReadonlySet<ApiKeyScope>>(new Set(['read']));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  const labelError = label.trim().length > 80 ? 'At most 80 characters.' : null;
  const canCreate = label.trim() !== '' && !labelError && scopes.size > 0 && busy === null;

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(failed(cause));
    } finally {
      setBusy(null);
    }
  };

  const create = () =>
    run('create', async () => {
      const result = unwrap(
        await api.createApiKey({ label: label.trim(), scopes: API_KEY_SCOPES.filter((scope) => scopes.has(scope)) }),
      );
      setCreated(result);
      setLabel('');
      await onChange();
    });

  const revoke = (key: ApiKey) =>
    run(key.id, async () => {
      await api.deleteApiKey(key.id);
      if (created?.apiKey.id === key.id) setCreated(null);
      await onChange();
    });

  const toggle = (scope: ApiKeyScope, on: boolean) => {
    const next = new Set(scopes);
    if (on) next.add(scope);
    else next.delete(scope);
    setScopes(next);
  };

  const columns: Column<ApiKey>[] = [
    { key: 'label', header: 'Label', cell: (key) => key.label },
    { key: 'prefix', header: 'Key', cell: (key) => <span className="font-mono">{key.prefix}…</span> },
    { key: 'scopes', header: 'Scopes', cell: (key) => <span className="font-mono">{key.scopes.join(', ')}</span> },
    { key: 'created', header: 'Created', cell: (key) => formatTime(key.createdAt) },
    { key: 'used', header: 'Last used', cell: (key) => formatTime(key.lastUsedAt) },
    {
      key: 'revoke',
      header: 'Actions',
      align: 'right',
      cell: (key) => (
        <Button
          variant="danger"
          size="sm"
          loading={busy === key.id}
          disabled={busy !== null}
          onClick={() => void revoke(key)}
          aria-label={`Revoke ${key.label}`}
        >
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="api-keys-heading" className={panelClass}>
      <h2 id="api-keys-heading" className={headingClass}>
        API keys
      </h2>
      <p className="mt-2 text-sm text-muted">
        Send a key in the <span className="font-mono">X-API-Key</span> header. Revoking a key stops it at once.
      </p>

      <div className="mt-4">
        {keys === null ? (
          <p className="text-sm text-muted">Loading keys…</p>
        ) : (
          <Table
            caption="Your API keys"
            columns={columns}
            rows={keys}
            rowKey={(key) => key.id}
            empty="No API keys yet."
          />
        )}
      </div>

      {created && (
        <div role="status" className="mt-4 rounded-card border border-border bg-surface-muted p-4">
          <p className="text-sm font-medium">Copy the secret of “{created.apiKey.label}” now</p>
          <p className="mt-1 text-caption text-muted">
            It is shown only once. Square stores only its hash and cannot show it again.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-md bg-surface px-2 py-1 font-mono text-sm">{created.secret}</code>
            <CopyButton value={created.secret} label="Copy the API key secret" />
          </div>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setCreated(null)}>
            I have saved it
          </Button>
        </div>
      )}

      <form
        className="mt-6 grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) void create();
        }}
      >
        <Field label="Label" hint="What uses the key, e.g. “report server”." error={labelError}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={inputClass}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
            />
          )}
        </Field>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Scopes</legend>
          {API_KEY_SCOPES.map((scope) => (
            <label key={scope} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={scopes.has(scope)}
                onChange={(event) => toggle(scope, event.target.checked)}
              />
              <span>
                <span className="font-mono">{scope}</span>
                <span className="text-muted"> · {SCOPE_INFO[scope]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {scopes.size === 0 && <p className="text-caption text-danger-text">Choose at least one scope.</p>}
        <div>
          <Button type="submit" disabled={!canCreate} loading={busy === 'create'}>
            Create key
          </Button>
        </div>
      </form>
      {error && (
        <div className="mt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </section>
  );
}
