'use client';

import { useEffect, useId, useState } from 'react';
import {
  ArbitrationEventTypeSchema,
  type ArbitrationEventType,
  type ArbitrationWebhook,
} from '@squaresdk/solana-types';
import type { ApiClientState } from '@/components/api-client';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ARBITRATION_EVENTS, webhookUrlProblem } from '@/lib/arbitration';
import { unwrap } from '@/lib/square-api';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const EVENTS = ArbitrationEventTypeSchema.options;

/**
 * Arbitrator'ın webhook abonelikleri (`/v1/arbitration/webhooks`, yalnızca oturum): liste, ekleme ve silme.
 * Standard Webhooks sırrı (`whsec_…`) yalnızca ekleme yanıtında döner; sayfa onu bir kez gösterir, saklamaz.
 */
export function WebhooksPanel({ session, allowHttp }: { session: ApiClientState; allowHttp: boolean }) {
  const { api, report } = session;
  const urlId = useId();
  const [list, setList] = useState<Load<ArbitrationWebhook[]>>({ state: 'loading' });
  const [reload, setReload] = useState(0);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<ArbitrationEventType[]>([...EVENTS]);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let active = true;
    api.listArbitrationWebhooks().then(
      (envelope) => active && setList({ state: 'ready', value: unwrap(envelope) }),
      (caught: unknown) => active && setList({ state: 'error', message: report(caught) }),
    );
    return () => {
      active = false;
    };
  }, [api, report, reload]);

  const urlProblem = url === '' ? null : webhookUrlProblem(url, allowHttp);
  const add = async () => {
    if (!api) return;
    setBusy('add');
    setError(null);
    try {
      const created = unwrap(await api.createArbitrationWebhook({ url, events }));
      setSecret({ url: created.webhook.url, secret: created.secret });
      setUrl('');
      setReload((n) => n + 1);
    } catch (caught) {
      setError(report(caught));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (id: string) => {
    if (!api) return;
    setBusy(id);
    setError(null);
    try {
      await api.deleteArbitrationWebhook(id);
      setReload((n) => n + 1);
    } catch (caught) {
      setError(report(caught));
    } finally {
      setBusy(null);
    }
  };

  if (!api) return null;
  return (
    <section aria-labelledby="webhooks-heading" className="rounded-card border border-border bg-surface p-6">
      <h2 id="webhooks-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
        Notifications
      </h2>
      <p className="mt-2 text-sm text-muted">
        The Square API posts signed Standard Webhooks to your endpoints when a dispute needs you. Verify them with the
        secret shown once when you add the endpoint.
      </p>
      {list.state === 'loading' && <p className="mt-3 text-sm text-muted">Reading your endpoints…</p>}
      {list.state === 'error' && <p className="mt-3 text-sm text-danger-text">{list.message}</p>}
      {list.state === 'ready' && list.value.length === 0 && (
        <p className="mt-3 text-sm text-muted">No endpoints yet.</p>
      )}
      {list.state === 'ready' && list.value.length > 0 && (
        <ul aria-label="Webhook endpoints" className="mt-3 grid gap-2 text-sm">
          {list.value.map((hook) => (
            <li key={hook.id} className="flex flex-wrap items-center gap-3 border-l-2 border-border pl-3">
              <span className="break-all font-mono">{hook.url}</span>
              <span className="text-caption text-muted">{hook.events.join(', ')}</span>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void remove(hook.id)}
                loading={busy === hook.id}
                disabled={busy !== null}
                aria-label={`Remove ${hook.url}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {secret && (
        <div className="mt-4 grid gap-1 rounded-card border border-border p-4 text-sm" role="status">
          <p>
            Signing secret for <span className="break-all font-mono">{secret.url}</span>. It is shown only now; store it
            with the endpoint.
          </p>
          <span className="flex flex-wrap items-center gap-2">
            <code className="break-all font-mono text-caption">{secret.secret}</code>
            <CopyButton value={secret.secret} label="Copy the signing secret" />
          </span>
        </div>
      )}
      <div className="mt-4 grid gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={urlId} className="text-sm font-medium">
            Endpoint URL
          </label>
          <input
            id={urlId}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
            value={url}
            onChange={(event) => setUrl(event.target.value.trim())}
            aria-invalid={Boolean(urlProblem)}
            autoComplete="off"
            spellCheck={false}
          />
          {urlProblem && <p className="text-caption text-danger-text">{urlProblem}</p>}
        </div>
        <fieldset className="grid gap-1.5">
          <legend className="text-sm font-medium">Events</legend>
          {EVENTS.map((event) => (
            <label key={event} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={(change) =>
                  setEvents((current) =>
                    change.target.checked
                      ? EVENTS.filter((e) => e === event || current.includes(e))
                      : current.filter((e) => e !== event),
                  )
                }
                className="accent-accent"
              />
              <span className="font-mono text-caption">{event}</span>
              <span className="text-caption text-muted">{ARBITRATION_EVENTS[event]}</span>
            </label>
          ))}
        </fieldset>
        <div>
          <Button
            variant="secondary"
            onClick={() => void add()}
            loading={busy === 'add'}
            disabled={url === '' || Boolean(urlProblem) || events.length === 0 || busy !== null}
          >
            Add the endpoint
          </Button>
        </div>
        {error && <p className="text-sm text-danger-text">{error}</p>}
      </div>
    </section>
  );
}
