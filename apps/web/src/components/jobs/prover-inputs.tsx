'use client';

import { useId } from 'react';

/**
 * İspatın girdileri (FE-09, FE-20): ödeme kategorisi (politikanın izin verdikleri) ve prover'ın API anahtarı. Anahtar
 * yalnızca bu sayfada tutulur ve yalnızca prover'a gider.
 */
export function ProverInputs({
  categories,
  category,
  onCategory,
  apiKey,
  onApiKey,
  disabled,
}: {
  categories: readonly string[];
  category: string;
  onCategory(category: string): void;
  apiKey: string;
  onApiKey(apiKey: string): void;
  disabled: boolean;
}) {
  const categoryId = useId();
  const keyId = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={categoryId} className="text-sm font-medium">
          Payment category
        </label>
        <select
          id={categoryId}
          value={category}
          onChange={(event) => onCategory(event.currentTarget.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
          disabled={disabled}
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={keyId} className="text-sm font-medium">
          Prover API key
        </label>
        <input
          id={keyId}
          type="password"
          value={apiKey}
          onChange={(event) => onApiKey(event.currentTarget.value)}
          aria-describedby={`${keyId}-hint`}
          autoComplete="off"
          className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
          disabled={disabled}
        />
        <p id={`${keyId}-hint`} className="text-caption text-muted">
          Kept in this page only and sent only to the prover.
        </p>
      </div>
    </div>
  );
}
