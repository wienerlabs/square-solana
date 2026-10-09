import { Reveal } from '@/components/ui/reveal';
import { InstructionList } from '@/components/ui/instruction-list';
import { FLOW_STEPS } from '@/lib/flow';

export function Flow() {
  return (
    <section aria-labelledby="flow-title" className="py-12">
      <Reveal>
        <p className="text-caption font-medium tracking-[0.14em] text-muted uppercase">The protocol</p>
        <h2 id="flow-title" className="mt-2 text-heading-sm font-semibold tracking-tight md:text-heading">
          From mandate to payment
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          Eight steps, each one a Solana instruction. On a job under a policy the proof (step 7) is bound before the
          keeper finalizes and pays out (steps 6 and 8); without a proof the escrow waits.
        </p>
      </Reveal>
      <div className="relative mt-10">
        {/* Adımları birleştiren hat (geniş ekranda her satırın ortasından). */}
        <Reveal
          aria-hidden="true"
          className="absolute inset-x-6 top-[38px] hidden h-px origin-left bg-[linear-gradient(90deg,transparent,var(--sq-accent)_8%,var(--sq-border)_50%,var(--sq-tone-success-dot)_92%,transparent)] opacity-70 lg:block [&[data-reveal=pending]]:scale-x-0 [&[data-reveal=shown]]:scale-x-100 [&[data-reveal=shown]]:transition-transform [&[data-reveal=shown]]:duration-[1400ms]"
        >
          {null}
        </Reveal>
        <ol className="relative grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FLOW_STEPS.map((step, index) => (
            <Reveal
              as="li"
              key={step.number}
              delay={(index % 4) * 80}
              className="card card-interactive relative flex flex-col gap-3 p-5"
            >
              <div className="flex items-center justify-between gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-9 items-center justify-center rounded-xl bg-[linear-gradient(135deg,var(--sq-accent),color-mix(in_oklab,var(--sq-accent)_55%,var(--sq-tone-info-dot)))] text-caption font-semibold text-on-accent shadow-[0_8px_20px_-10px_var(--sq-accent)]"
                >
                  {String(step.number).padStart(2, '0')}
                </span>
                <span className="rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-caption text-muted">
                  {step.actor}
                </span>
              </div>
              <h3 className="font-semibold tracking-tight">
                <span className="sr-only">Step {step.number}: </span>
                {step.title}
              </h3>
              <p className="text-sm leading-relaxed text-muted">{step.summary}</p>
              <div className="mt-auto border-t border-border/70 pt-3">
                <p className="mb-2 text-[10px] font-medium tracking-[0.14em] text-muted uppercase">On chain</p>
                <InstructionList instructions={step.instructions} label={`Step ${step.number} instructions`} />
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
