'use client';

import { useId, useState } from 'react';
import { JobStatusSchema, type JobStatus, type JobView } from '@squaresdk/solana-types';
import { Button } from '@/components/ui/button';
import { Table, type Column } from '@/components/ui/table';
import { statusLabel } from '@/lib/status';

/** Bir seferde gösterilen satır; "Show more" sonrakileri açar. */
export const JOBS_PAGE = 25;

/** Panelin işleri: durum süzgeci, yeniden eskiye; liste kesildiyse kaçının okunduğu yazılır. */
export function JobsTable({
  caption,
  jobs,
  total,
  columns,
}: {
  caption: string;
  jobs: readonly JobView[];
  total: number;
  columns: readonly Column<JobView>[];
}) {
  const id = useId();
  const [status, setStatus] = useState<JobStatus | 'all'>('all');
  const [shown, setShown] = useState(JOBS_PAGE);
  const counts = new Map<JobStatus, number>();
  for (const job of jobs) counts.set(job.account.status, (counts.get(job.account.status) ?? 0) + 1);
  const rows = status === 'all' ? jobs : jobs.filter((job) => job.account.status === status);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2">
          <label htmlFor={id} className="text-muted">
            Status
          </label>
          <select
            id={id}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as JobStatus | 'all');
              setShown(JOBS_PAGE);
            }}
            className="rounded-md border border-border bg-surface px-2 py-1"
          >
            <option value="all">All ({jobs.length})</option>
            {JobStatusSchema.options
              .filter((value) => counts.has(value))
              .map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)} ({counts.get(value)})
                </option>
              ))}
          </select>
        </div>
        {total > jobs.length && (
          <span className="text-caption text-muted">
            The newest {jobs.length.toLocaleString('en-US')} of {total.toLocaleString('en-US')} jobs are read.
          </span>
        )}
      </div>
      <Table
        caption={caption}
        columns={columns}
        rows={rows.slice(0, shown)}
        rowKey={(job) => job.address}
        empty={status === 'all' ? 'No jobs yet.' : 'No jobs with this status.'}
      />
      {rows.length > shown && (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setShown((value) => value + JOBS_PAGE)}>
            Show {Math.min(JOBS_PAGE, rows.length - shown)} more of {rows.length - shown}
          </Button>
        </div>
      )}
    </div>
  );
}
