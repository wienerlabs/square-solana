export type StepState = 'done' | 'current' | 'upcoming' | 'error';

export interface StepItem {
  title: string;
  description?: string;
  state: StepState;
}

const STATE_TEXT: Record<StepState, string> = {
  done: 'completed',
  current: 'current step',
  upcoming: 'not started',
  error: 'failed',
};

const BADGE: Record<StepState, string> = {
  done: 'bg-text text-surface',
  current: 'bg-accent text-on-accent',
  upcoming: 'border border-border bg-surface text-muted',
  error: 'bg-tone-danger-bg text-danger-text',
};

export function StepIndicator({ label, steps }: { label: string; steps: readonly StepItem[] }) {
  return (
    <ol aria-label={label} className="flex flex-col">
      {steps.map((step, index) => (
        <li
          key={step.title}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className="flex gap-4 pb-5 last:pb-0"
        >
          <span
            aria-hidden="true"
            className={`flex size-7 shrink-0 items-center justify-center rounded-full text-caption font-medium tabular-nums ${BADGE[step.state]}`}
          >
            {step.state === 'done' ? '✓' : step.state === 'error' ? '!' : index + 1}
          </span>
          <div className="min-w-0 pt-0.5">
            <p className={step.state === 'upcoming' ? 'text-muted' : 'font-medium'}>
              <span className="sr-only">Step {index + 1}: </span>
              {step.title}
              <span className="sr-only">, {STATE_TEXT[step.state]}</span>
            </p>
            {step.description && <p className="mt-0.5 text-caption text-muted">{step.description}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
