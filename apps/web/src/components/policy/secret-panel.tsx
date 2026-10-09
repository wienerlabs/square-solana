'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { createBackup } from '@/lib/policy-local';
import type { PolicyWorkspace } from '@/lib/use-policy-workspace';

function download(owner: string, cluster: string, workspace: PolicyWorkspace) {
  const backup = createBackup(owner, workspace.secret!, workspace.drafts);
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `square-policy-${cluster}-${owner}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function SecretPanel({
  owner,
  cluster,
  workspace,
}: {
  owner: string;
  cluster: string;
  workspace: PolicyWorkspace;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const onFile = async (input: HTMLInputElement) => {
    const chosen = input.files?.[0];
    input.value = '';
    if (chosen) setRestoreError(workspace.restore(await chosen.text()));
  };

  return (
    <section aria-labelledby="secret-heading" className="card p-6">
      <h2 id="secret-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
        Policy secret
      </h2>
      <p className="mt-2 text-sm text-muted">
        A 32-byte secret derives the salts that hide every policy of this wallet. It stays in this browser and is never
        sent to a server. Without it no release proof can be built, so the jobs under these policies cannot be paid out.
      </p>
      {workspace.secret ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => download(owner, cluster, workspace)}>
            Download backup
          </Button>
          <span className="text-caption text-muted">
            The file holds the secret, the policies and the buyer salts. Keep it offline.
          </span>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={workspace.createSecret}>Create a secret</Button>
          <Button variant="secondary" onClick={() => file.current?.click()}>
            Restore from backup
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            aria-label="Policy backup file"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => void onFile(event.currentTarget)}
          />
        </div>
      )}
      {!workspace.stored && (
        <p role="alert" className="mt-3 text-sm text-danger-text">
          This browser did not keep the data (private window or blocked site data). Download a backup before leaving.
        </p>
      )}
      {restoreError && (
        <p role="alert" className="mt-3 text-sm text-danger-text">
          {restoreError}
        </p>
      )}
    </section>
  );
}
