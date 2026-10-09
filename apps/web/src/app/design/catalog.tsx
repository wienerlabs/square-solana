'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { StepIndicator, type StepState } from '@/components/ui/step-indicator';
import { TX_STAGES } from '@/components/ui/tx-confirmation';
import { ThemeToggle } from '@/components/theme-toggle';
import { FLOW_STEPS } from '@/lib/flow';
import { STATUS_SETS, statusLabel } from '@/lib/status';
import { COLOR_TOKENS, TEXT_STYLES } from '@/styles/tokens';
import { ConnectedIdentity, LatestTransaction, PerformanceTable, TokenSwatches } from './live-examples';

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="card p-6">
      <h2 id={id} className="text-subheading font-semibold">
        {title}
      </h2>
      {note && <p className="mt-1 text-sm text-muted">{note}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

const STEP_STATES: StepState[] = ['done', 'current', 'upcoming', 'error'];

export function Catalog() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-heading-sm font-semibold">Design system</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Tokens and base components of the Square web app. Nothing here is sample data: statuses come from the program
          IDLs, the flow from the protocol, and the address, table and transaction from the connected wallet and the
          configured cluster.
        </p>
      </div>

      <Section
        id="theme"
        title="Theme"
        note="Light, dark or the system preference. Every pair below meets WCAG 2.2 AA in both themes."
      >
        <div className="mb-6">
          <ThemeToggle />
        </div>
        <TokenSwatches names={COLOR_TOKENS} />
      </Section>

      <Section id="typography" title="Typography" note="OpenRunde, the typeface of Arc Square.">
        <ul className="flex flex-col gap-3">
          {TEXT_STYLES.map((style) => (
            <li key={style.name} className="flex flex-wrap items-baseline gap-x-4">
              <span className={`${style.className} font-medium`}>{style.name}</span>
              <span className="font-mono text-caption text-muted">
                {style.className} · {style.size}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="buttons" title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
          <Button loading>Loading</Button>
          <Button size="sm">Small</Button>
        </div>
      </Section>

      <Section id="status" title="Status badges" note="Every value of each on-chain status, in IDL order.">
        <div className="flex flex-col gap-4">
          {STATUS_SETS.map((set) => (
            <div key={set.name}>
              <p className="text-sm font-medium">
                {set.name} <span className="font-mono text-caption font-normal text-muted">{set.account}</span>
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {set.items.map(({ value, tone }) => (
                  <li key={value}>
                    <StatusBadge tone={tone}>{statusLabel(value)}</StatusBadge>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section id="steps" title="Step indicator" note="The eight steps from mandate to payment.">
        <div className="grid gap-8 md:grid-cols-[1fr_max-content]">
          <StepIndicator
            label="Mandate to payment"
            steps={FLOW_STEPS.map((step) => ({
              title: step.title,
              description: `${step.actor} · ${step.instructions.join(', ')}`,
              state: 'upcoming',
            }))}
          />
          <div>
            <p className="mb-3 text-sm font-medium">States</p>
            <StepIndicator
              label="Step states"
              steps={STEP_STATES.map((state) => ({ title: statusLabel(state), state }))}
            />
          </div>
        </div>
      </Section>

      <Section
        id="identity"
        title="Address and DID"
        note="Shortened for display; the full value goes to screen readers and the clipboard."
      >
        <ConnectedIdentity />
      </Section>

      <Section id="table" title="Table" note="Recent performance samples of the configured cluster.">
        <PerformanceTable />
      </Section>

      <Section
        id="tx"
        title="Transaction confirmation"
        note="The latest transaction of the connected wallet, followed to finalized."
      >
        <LatestTransaction />
        <p className="mt-5 mb-2 text-sm font-medium">Stages</p>
        <ul className="flex flex-wrap gap-2">
          {Object.entries(TX_STAGES).map(([stage, { label, tone }]) => (
            <li key={stage}>
              <StatusBadge tone={tone}>{label}</StatusBadge>
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}
