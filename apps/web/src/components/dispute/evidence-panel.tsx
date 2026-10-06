'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import type { DisputeEvidence } from '@squaresdk/solana-types';
import type { ApiClientState } from '@/components/api-client';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { evidenceFileName } from '@/lib/arbitration';
import { unwrap } from '@/lib/square-api';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ROLE_LABEL: Readonly<Record<DisputeEvidence['role'], string>> = {
  institution: 'Institution',
  agent: 'Agent',
  arbitrator: 'Arbitrator',
};

/**
 * Dispute kanıtları (`GET /v1/disputes/{job}/evidence`): yalnızca taraflar (kurum, agent, aktif arbitrator'lar)
 * okur; API yetkiyi denetler. Kanıt baytları ek olarak indirilir, sayfada açılmaz. `canUpload` iken
 * taraf dispute açıldıktan sonra kanıt ekler.
 */
export function EvidencePanel({
  session,
  job,
  canUpload,
  initial,
  revision = 0,
}: {
  session: ApiClientState;
  job: string;
  canUpload: boolean;
  /** Kuyruk öğesinin taşıdığı liste: konsolda ayrı istek gerekmez. */
  initial?: DisputeEvidence[];
  revision?: number;
}) {
  const { api, report } = session;
  const fileId = useId();
  const [list, setList] = useState<Load<DisputeEvidence[]>>(
    initial ? { state: 'ready', value: initial } : { state: 'loading' },
  );
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) setList({ state: 'ready', value: initial });
  }, [initial]);
  useEffect(() => {
    if (!api || (initial && reload === 0)) return;
    let active = true;
    api.listDisputeEvidence(job).then(
      (envelope) => active && setList({ state: 'ready', value: unwrap(envelope) }),
      (caught: unknown) => active && setList({ state: 'error', message: report(caught) }),
    );
    return () => {
      active = false;
    };
  }, [api, job, report, initial, reload, revision]);

  const download = useCallback(
    async (item: DisputeEvidence) => {
      if (!api) return;
      setBusy(item.id);
      setError(null);
      try {
        const blob = await api.getDisputeEvidenceContent(job, item.id);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = evidenceFileName(job, item.reasonHash);
        link.click();
        URL.revokeObjectURL(url);
      } catch (caught) {
        setError(report(caught));
      } finally {
        setBusy(null);
      }
    },
    [api, job, report],
  );

  const upload = async (file: File) => {
    if (!api) return;
    setBusy('upload');
    setError(null);
    try {
      unwrap(await api.uploadDisputeEvidence(job, file));
      setReload((n) => n + 1);
    } catch (caught) {
      setError(report(caught));
    } finally {
      setBusy(null);
    }
  };

  if (!api) return null;
  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">Evidence</h3>
      {list.state === 'loading' && <p className="text-sm text-muted">Reading the evidence…</p>}
      {list.state === 'error' && <p className="text-sm text-danger-text">{list.message}</p>}
      {list.state === 'ready' && list.value.length === 0 && <p className="text-sm text-muted">No evidence yet.</p>}
      {list.state === 'ready' && list.value.length > 0 && (
        <ul aria-label="Dispute evidence" className="grid gap-2 text-sm">
          {list.value.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 border-l-2 border-border pl-3">
              <span className="font-medium">{ROLE_LABEL[item.role]}</span>
              <Address value={item.uploadedBy} label="uploader" />
              {item.isDisputeReason && <StatusBadge tone="info">Dispute reason</StatusBadge>}
              <span className="text-caption text-muted">
                {item.contentType}, {item.size} bytes, <time dateTime={iso(item.createdAt)}>{iso(item.createdAt)}</time>
              </span>
              <code className="break-all font-mono text-caption">{item.reasonHash}</code>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void download(item)}
                loading={busy === item.id}
                disabled={busy !== null}
              >
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fileId} className="text-sm font-medium">
            Add evidence
          </label>
          <input
            id={fileId}
            type="file"
            className="text-sm"
            disabled={busy !== null}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void upload(file);
            }}
            aria-describedby={`${fileId}-hint`}
          />
          <p id={`${fileId}-hint`} className="text-caption text-muted">
            Stored privately by the Square API; only the parties and the arbitrators can read it.
          </p>
        </div>
      )}
      {error && <p className="text-sm text-danger-text">{error}</p>}
    </div>
  );
}
