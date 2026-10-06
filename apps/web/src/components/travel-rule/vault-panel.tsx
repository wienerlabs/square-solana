'use client';

import { useId, useRef, useState } from 'react';
import { useWebConfig } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { passphraseProblem, type VaultFile } from '@/lib/travel-rule-local';
import type { TravelRuleVault } from '@/lib/use-travel-rule-vault';

const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text aria-invalid:border-danger-text';

function download(file: VaultFile, cluster: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `square-travel-rule-${cluster}-${file.owner}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Kurumun Travel Rule deposu: parolayla oluşturma ve açma, şifreli dışa aktarma ve geri yükleme. Parola
 * saklanmaz; depo yalnızca şifreli hâliyle yazılır.
 */
export function TravelRuleVaultPanel({ vault }: { vault: TravelRuleVault }) {
  const { cluster } = useWebConfig();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!vault.loaded) return <p className="text-sm text-muted">Reading the Travel Rule store…</p>;

  const newProblem = vault.exists ? null : passphraseProblem(passphrase, confirmation);
  const act = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const problem = await action();
      setError(problem);
      if (!problem) {
        setPassphrase('');
        setConfirmation('');
        setRestorePassphrase('');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (input: HTMLInputElement) => {
    const chosen = input.files?.[0];
    input.value = '';
    if (chosen) await act(async () => vault.restore(await chosen.text(), restorePassphrase));
  };
  const canRestore = !vault.exists || vault.unlocked;

  return (
    <div className="grid gap-3 rounded-lg border border-border p-4">
      <p className="text-sm text-muted">
        Travel Rule records hold personal data. They stay in this browser, encrypted with a passphrase you choose
        (PBKDF2-SHA-256, AES-256-GCM), and are never sent to a server or put on chain. The passphrase is not stored:
        without it the records cannot be read.
      </p>
      {!vault.exists && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-new`} className="text-sm font-medium">
              New passphrase
            </label>
            <input
              id={`${id}-new`}
              type="password"
              className={inputClass}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-confirm`} className="text-sm font-medium">
              Repeat the passphrase
            </label>
            <input
              id={`${id}-confirm`}
              type="password"
              className={inputClass}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              aria-invalid={confirmation !== '' && confirmation !== passphrase}
            />
          </div>
          {passphrase !== '' && newProblem && <p className="text-caption text-muted sm:col-span-2">{newProblem}</p>}
          <div className="sm:col-span-2">
            <Button
              onClick={() =>
                void act(async () => {
                  await vault.create(passphrase);
                  return null;
                })
              }
              loading={busy}
              disabled={newProblem !== null}
            >
              Create the encrypted store
            </Button>
          </div>
        </div>
      )}
      {vault.exists && !vault.unlocked && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => vault.unlock(passphrase));
          }}
        >
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <label htmlFor={`${id}-unlock`} className="text-sm font-medium">
              Passphrase
            </label>
            <input
              id={`${id}-unlock`}
              type="password"
              className={inputClass}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" loading={busy} disabled={passphrase === ''}>
            Unlock the records
          </Button>
        </form>
      )}
      {vault.unlocked && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">
            Unlocked: {vault.entries.length} record{vault.entries.length === 1 ? '' : 's'}
          </span>
          <Button variant="secondary" size="sm" onClick={() => vault.file && download(vault.file, cluster)}>
            Download encrypted export
          </Button>
          <Button variant="ghost" size="sm" onClick={vault.lock}>
            Lock
          </Button>
        </div>
      )}
      {canRestore && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <label htmlFor={`${id}-restore`} className="text-sm font-medium">
              Passphrase of an export
            </label>
            <input
              id={`${id}-restore`}
              type="password"
              className={inputClass}
              value={restorePassphrase}
              onChange={(event) => setRestorePassphrase(event.target.value)}
              autoComplete="off"
            />
          </div>
          <Button variant="secondary" onClick={() => file.current?.click()} disabled={busy || restorePassphrase === ''}>
            Restore from export
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            aria-label="Travel Rule export file"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => void onFile(event.currentTarget)}
          />
        </div>
      )}
      <p className="text-caption text-muted">
        Keep the encrypted export offline: it is the only copy outside this browser, and the counterparty or an auditor
        needs the record and its salt to check the commitment.
      </p>
      {!vault.stored && (
        <p role="alert" className="text-sm text-danger-text">
          This browser did not keep the records (private window or blocked site data). Download the encrypted export
          before leaving.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
