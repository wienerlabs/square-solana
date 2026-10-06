'use client';

// x402 ücretli uç noktalar (FE-22): tanımlar (yol ve ad, fiyat, mint, ağ, alıcı, açıklama, etkin / pasif),
// oluşturma, düzenleme, pasifleştirme, silme ve seçilen tanımın kullanımı (ödemeli çağrı sayısı, tahsil edilen
// tutar, son ödemeler). Ödemeyi geliştiricinin sunucusu ister; kullanım onun bildirdiği uzlaştırmalardır.
import { useEffect, useState } from 'react';
import type { X402Endpoint, X402EndpointUsage, X402Payment } from '@squaresdk/solana-types';
import type { SquareApi } from '@squaresdk/solana-sdk';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, type Column } from '@/components/ui/table';
import type { Cluster } from '@/lib/config';
import {
  USDC_MINTS,
  X402_NETWORKS,
  checkEndpointDraft,
  formatPrice,
  formatTime,
  isUsdc,
  networkLabel,
  newEndpointDraft,
  type DraftField,
  type EndpointDraft,
} from '@/lib/developer-portal';
import { formatUnits } from '@/lib/settlement';
import { unwrap } from '@/lib/square-api';
import { ErrorText, Field, headingClass, inputClass, panelClass } from './field';

const draftOf = (endpoint: X402Endpoint): EndpointDraft => ({
  name: endpoint.name,
  path: endpoint.path,
  description: endpoint.description ?? '',
  price: isUsdc(endpoint.mint, endpoint.network)
    ? formatUnits(BigInt(endpoint.amount), 6, { grouping: false })
    : endpoint.amount,
  mint: endpoint.mint,
  network: endpoint.network,
  payTo: endpoint.payTo,
  enabled: endpoint.enabled,
});

function EndpointForm({
  initial,
  editing,
  busy,
  onSubmit,
  onCancel,
}: {
  initial: EndpointDraft;
  editing: boolean;
  busy: boolean;
  onSubmit: (draft: EndpointDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    setDraft(initial);
    setTouched(false);
  }, [initial]);
  const check = checkEndpointDraft(draft);
  const errorOf = (field: DraftField) => (touched && !check.ok ? check.errors[field] : undefined);
  const set = <K extends keyof EndpointDraft>(field: K, value: EndpointDraft[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const usdc = isUsdc(draft.mint.trim(), draft.network);

  return (
    <form
      className="grid gap-4"
      aria-label={editing ? 'Edit paid endpoint' : 'New paid endpoint'}
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (check.ok) onSubmit(draft);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={errorOf('name')}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={inputClass}
              value={draft.name}
              onChange={(event) => set('name', event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Path" hint="The route on your server, e.g. /v1/report." error={errorOf('path')}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={`${inputClass} font-mono`}
              value={draft.path}
              onChange={(event) => set('path', event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Field label="Network">
          {({ id, describedBy }) => (
            <select
              id={id}
              className={inputClass}
              value={draft.network}
              aria-describedby={describedBy}
              onChange={(event) => {
                const network = event.target.value as EndpointDraft['network'];
                // USDC seçiliyse ağın USDC'sine geçer; başka bir mint olduğu gibi kalır.
                setDraft((current) => ({
                  ...current,
                  network,
                  mint: isUsdc(current.mint, current.network) ? USDC_MINTS[network] : current.mint,
                }));
              }}
            >
              {X402_NETWORKS.map((network) => (
                <option key={network.id} value={network.id}>
                  {network.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Mint"
          hint={usdc ? 'USDC on this network.' : 'A token mint; the price is in its base units.'}
          error={errorOf('mint')}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={`${inputClass} font-mono`}
              value={draft.mint}
              onChange={(event) => set('mint', event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Field
          label={usdc ? 'Price per call (USDC)' : 'Price per call (base units)'}
          hint={check.ok ? formatPrice(check.body.amount, check.body.mint, check.body.network) : undefined}
          error={errorOf('price')}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={`${inputClass} font-mono`}
              value={draft.price}
              onChange={(event) => set('price', event.target.value.trim())}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              inputMode="decimal"
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Pay to" hint="The wallet that receives the payments." error={errorOf('payTo')}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={`${inputClass} font-mono`}
              value={draft.payTo}
              onChange={(event) => set('payTo', event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
      </div>
      <Field label="Description" hint="Shown to payers in the 402 response." error={errorOf('description')}>
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            className={inputClass}
            rows={2}
            value={draft.description}
            onChange={(event) => set('description', event.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} />
        Enabled: charge for calls (a disabled endpoint refuses them)
      </label>
      <div className="flex gap-2">
        <Button type="submit" loading={busy}>
          {editing ? 'Save changes' : 'Create endpoint'}
        </Button>
        {editing && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function Usage({ endpoint, usage }: { endpoint: X402Endpoint; usage: X402EndpointUsage | null }) {
  if (!usage) return <p className="text-sm text-muted">Loading usage…</p>;
  const columns: Column<X402Payment>[] = [
    { key: 'at', header: 'Settled', cell: (payment) => formatTime(payment.settledAt) },
    { key: 'payer', header: 'Payer', cell: (payment) => <Address value={payment.payer} label="payer" /> },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (payment) => formatPrice(payment.amount, payment.asset, payment.network),
    },
    {
      key: 'tx',
      header: 'Transaction',
      cell: (payment) => <Address value={payment.transaction} label="transaction" />,
    },
  ];
  return (
    <div className="grid gap-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted">Paid calls</dt>
          <dd className="text-heading-sm font-semibold">{usage.payments.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt className="text-muted">Collected</dt>
          <dd className="font-semibold">
            {usage.totals.length === 0
              ? formatPrice('0', endpoint.mint, endpoint.network)
              : usage.totals.map((total) => (
                  <span key={`${total.network}:${total.asset}`} className="block">
                    {formatPrice(total.amount, total.asset, total.network)}
                  </span>
                ))}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Last payment</dt>
          <dd className="font-semibold">{formatTime(usage.lastPaidAt)}</dd>
        </div>
      </dl>
      <Table
        caption={`Recent payments for ${endpoint.name}`}
        columns={columns}
        rows={usage.recent}
        rowKey={(payment) => payment.id}
        empty="No payments yet. Your server reports each settled payment."
      />
    </div>
  );
}

export function X402EndpointsPanel({
  api,
  cluster,
  wallet,
  endpoints,
  selected,
  onSelect,
  onChange,
  failed,
}: {
  api: SquareApi;
  cluster: Cluster;
  wallet: string;
  endpoints: readonly X402Endpoint[] | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: () => Promise<void>;
  failed: (error: unknown) => string;
}) {
  const [editing, setEditing] = useState<X402Endpoint | null>(null);
  const [initial, setInitial] = useState(() => newEndpointDraft(cluster, wallet));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<X402EndpointUsage | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const current = endpoints?.find((endpoint) => endpoint.id === selected) ?? null;

  useEffect(() => {
    setUsage(null);
    if (!selected) return;
    let active = true;
    api
      .getX402EndpointUsage(selected)
      .then(unwrap)
      .then(
        (result) => active && setUsage(result),
        (cause: unknown) => active && setError(failed(cause)),
      );
    return () => {
      active = false;
    };
  }, [api, selected, failed, endpoints, refreshes]);

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

  const submit = (draft: EndpointDraft) =>
    run('form', async () => {
      const check = checkEndpointDraft(draft);
      if (!check.ok) return;
      const saved = editing
        ? unwrap(await api.updateX402Endpoint(editing.id, check.body))
        : unwrap(await api.createX402Endpoint(check.body));
      setEditing(null);
      setInitial(newEndpointDraft(cluster, wallet));
      await onChange();
      onSelect(saved.id);
    });

  const setEnabled = (endpoint: X402Endpoint, enabled: boolean) =>
    run(endpoint.id, async () => {
      unwrap(await api.updateX402Endpoint(endpoint.id, { enabled }));
      await onChange();
    });

  const remove = (endpoint: X402Endpoint) =>
    run(endpoint.id, async () => {
      await api.deleteX402Endpoint(endpoint.id);
      if (selected === endpoint.id) onSelect(null);
      if (editing?.id === endpoint.id) setEditing(null);
      await onChange();
    });

  const columns: Column<X402Endpoint>[] = [
    { key: 'name', header: 'Name', cell: (endpoint) => endpoint.name },
    { key: 'path', header: 'Path', cell: (endpoint) => <span className="font-mono">{endpoint.path}</span> },
    {
      key: 'price',
      header: 'Price per call',
      cell: (endpoint) => formatPrice(endpoint.amount, endpoint.mint, endpoint.network),
    },
    { key: 'network', header: 'Network', cell: (endpoint) => networkLabel(endpoint.network) },
    {
      key: 'status',
      header: 'Status',
      cell: (endpoint) =>
        endpoint.enabled ? (
          <StatusBadge tone="success">Enabled</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Disabled</StatusBadge>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (endpoint) => (
        <span className="inline-flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={selected === endpoint.id}
            aria-label={`Usage and snippets for ${endpoint.name}`}
            onClick={() => onSelect(endpoint.id)}
          >
            Usage
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${endpoint.name}`}
            onClick={() => {
              setEditing(endpoint);
              setInitial(draftOf(endpoint));
            }}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            aria-label={`${endpoint.enabled ? 'Disable' : 'Enable'} ${endpoint.name}`}
            onClick={() => void setEnabled(endpoint, !endpoint.enabled)}
          >
            {endpoint.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy !== null}
            aria-label={`Delete ${endpoint.name}`}
            onClick={() => void remove(endpoint)}
          >
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <section aria-labelledby="x402-heading" className={panelClass}>
      <h2 id="x402-heading" className={headingClass}>
        Paid endpoints (x402)
      </h2>
      <p className="mt-2 text-sm text-muted">
        Define what a route on your server costs. Your server asks for the payment with{' '}
        <span className="font-mono">paidRouteFromDefinition</span>, settles it with its own facilitator and reports it
        here. Square is not in the payment path.
      </p>
      <div className="mt-4">
        {endpoints === null ? (
          <p className="text-sm text-muted">Loading endpoints…</p>
        ) : (
          <Table
            caption="Paid endpoints"
            columns={columns}
            rows={endpoints}
            rowKey={(endpoint) => endpoint.id}
            empty="No paid endpoints yet."
          />
        )}
      </div>

      {current && (
        <section aria-labelledby="x402-usage-heading" className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="x402-usage-heading" className="text-sm font-medium">
              Usage of {current.name} <span className="font-mono text-muted">{current.path}</span>
            </h3>
            <Button variant="secondary" size="sm" onClick={() => setRefreshes((count) => count + 1)}>
              Refresh usage
            </Button>
          </div>
          <div className="mt-3">
            <Usage endpoint={current} usage={usage} />
          </div>
        </section>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-medium">{editing ? `Edit ${editing.name}` : 'New paid endpoint'}</h3>
        <div className="mt-3">
          <EndpointForm
            initial={initial}
            editing={editing !== null}
            busy={busy === 'form'}
            onSubmit={(draft) => void submit(draft)}
            onCancel={() => {
              setEditing(null);
              setInitial(newEndpointDraft(cluster, wallet));
            }}
          />
        </div>
      </div>
      {error && (
        <div className="mt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </section>
  );
}
