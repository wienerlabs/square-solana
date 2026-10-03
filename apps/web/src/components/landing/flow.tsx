import { FLOW_STEPS } from '@/lib/flow';

export function Flow() {
  return (
    <section aria-labelledby="flow-title" className="py-12">
      <h2 id="flow-title" className="text-heading-sm font-semibold">
        From mandate to payment
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Eight steps, each one a Solana instruction. On a job under a policy the proof (step 7) is bound before the
        keeper finalizes and pays out (steps 6 and 8); without a proof the escrow waits.
      </p>
      <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FLOW_STEPS.map((step) => (
          <li
            key={step.number}
            className="relative flex flex-col gap-3 rounded-card border border-border bg-surface p-5"
          >
            <div className="flex items-center justify-between gap-3">
              <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center rounded-full bg-accent text-caption font-semibold text-on-accent"
              >
                {step.number}
              </span>
              <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-caption text-muted">{step.actor}</span>
            </div>
            <h3 className="font-semibold">
              <span className="sr-only">Step {step.number}: </span>
              {step.title}
            </h3>
            <p className="mt-auto font-mono text-caption break-words text-muted">{step.instructions}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
