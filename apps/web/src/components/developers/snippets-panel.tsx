'use client';

// SDK örnekleri (FE-22): seçilen anahtar ve ücretli uç noktayla doldurulur, kopyalanır. Örneklerin gerçek
// dışa aktarımlarla derlendiği test/developer-snippets.test.ts'tedir.
import type { ApiKey, X402Endpoint } from '@squaresdk/solana-types';
import { CopyButton } from '@/components/ui/copy-button';
import { apiClientSnippet, paidRouteSnippet, payingFetchSnippet, type Snippet } from '@/lib/developer-snippets';
import { Field, headingClass, inputClass, panelClass } from './field';

function SnippetBlock({ snippet }: { snippet: Snippet }) {
  const id = `snippet-${snippet.id}`;
  return (
    <figure className="grid gap-2" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption id={`${id}-title`} className="text-sm font-medium">
          {snippet.title}
        </figcaption>
        <CopyButton value={snippet.code} label={`Copy the snippet: ${snippet.title}`} />
      </div>
      <p className="text-caption text-muted">{snippet.description}</p>
      <pre
        tabIndex={0}
        aria-label={`${snippet.title} (TypeScript)`}
        className="overflow-x-auto rounded-lg border border-border bg-surface-muted p-4 font-mono text-caption"
      >
        <code>{snippet.code}</code>
      </pre>
    </figure>
  );
}

export function SnippetsPanel({
  apiUrl,
  keys,
  endpoints,
  keyId,
  endpointId,
  onKey,
  onEndpoint,
}: {
  apiUrl: string;
  keys: readonly ApiKey[];
  endpoints: readonly X402Endpoint[];
  keyId: string | null;
  endpointId: string | null;
  onKey: (id: string | null) => void;
  onEndpoint: (id: string | null) => void;
}) {
  const key = keys.find((candidate) => candidate.id === keyId) ?? null;
  const endpoint = endpoints.find((candidate) => candidate.id === endpointId) ?? null;
  const snippets = [
    apiClientSnippet({ apiUrl, key }),
    ...(endpoint ? [paidRouteSnippet({ apiUrl, endpoint, key }), payingFetchSnippet({ endpoint })] : []),
  ];

  return (
    <section aria-labelledby="snippets-heading" className={panelClass}>
      <h2 id="snippets-heading" className={headingClass}>
        SDK snippets
      </h2>
      <p className="mt-2 text-sm text-muted">
        TypeScript, filled in with the key and endpoint you pick. Secrets stay in environment variables.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="API key">
          {({ id }) => (
            <select
              id={id}
              className={inputClass}
              value={key?.id ?? ''}
              onChange={(event) => onKey(event.target.value || null)}
            >
              <option value="">No key selected</option>
              {keys.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label} ({candidate.prefix}…)
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Paid endpoint">
          {({ id }) => (
            <select
              id={id}
              className={inputClass}
              value={endpoint?.id ?? ''}
              onChange={(event) => onEndpoint(event.target.value || null)}
            >
              <option value="">No endpoint selected</option>
              {endpoints.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} ({candidate.path})
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {!endpoint && <p className="mt-4 text-sm text-muted">Pick a paid endpoint for the server and client snippets.</p>}
      <div className="mt-6 grid gap-8">
        {snippets.map((snippet) => (
          <SnippetBlock key={snippet.id} snippet={snippet} />
        ))}
      </div>
    </section>
  );
}
