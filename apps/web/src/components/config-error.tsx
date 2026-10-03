import { CLUSTERS, ENV_VARS, PROGRAMS, PROGRAM_ID_ENV } from '@/lib/config';

// Sunucu bileşeni: yapılandırma eksikse uygulamanın yerine gösterilir. Varsayılana düşülmez.
export function ConfigError({ errors }: { errors: string[] }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-xl font-semibold">This deployment is not configured</h1>
      <p className="mt-2 text-sm text-muted">
        The network settings come from the environment and have no defaults. Set the variables below and restart.
      </p>
      <ul role="alert" className="mt-6 list-disc space-y-1 pl-5 font-mono text-sm text-danger-text">
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
      <dl className="mt-8 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="font-mono">{ENV_VARS.cluster}</dt>
        <dd className="text-muted">{CLUSTERS.join(' | ')}</dd>
        <dt className="font-mono">{ENV_VARS.rpcUrl}</dt>
        <dd className="text-muted">JSON-RPC endpoint of that cluster (https)</dd>
        {PROGRAMS.map((program) => (
          <div key={program} className="contents">
            <dt className="font-mono">{PROGRAM_ID_ENV[program]}</dt>
            <dd className="text-muted">Optional: address of the {program} program on that cluster</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
