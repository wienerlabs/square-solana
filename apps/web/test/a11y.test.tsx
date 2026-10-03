// @vitest-environment jsdom
// Erişilebilirlik denetimi: her temel bileşen axe-core'un WCAG 2.2 A/AA kurallarından geçer.
// Renk kontrastı jsdom'da hesaplanamaz (yerleşim yok); onu test/contrast.test.ts token'lar üzerinden denetler.
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Address, Did } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { StepIndicator } from '@/components/ui/step-indicator';
import { Table } from '@/components/ui/table';
import { TX_STAGES, TxConfirmation, type TxStage } from '@/components/ui/tx-confirmation';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { FLOW_STEPS } from '@/lib/flow';

afterEach(cleanup);

async function violations(ui: ReactElement) {
  const { container } = render(<main>{ui}</main>);
  const result = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help}`);
}

// Gerçek bir adres (devnet USDC mint'i) ve onun devnet'teki did:pkh'si (BC-14 §5'teki controller biçimi).
const ADDRESS = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('axe', () => {
  it('Button: every variant, disabled and loading', async () => {
    expect(
      await violations(
        <div>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
          <Button loading>Loading</Button>
        </div>,
      ),
    ).toEqual([]);
  });

  it('StatusBadge', async () => {
    expect(await violations(<StatusBadge tone="success">Released</StatusBadge>)).toEqual([]);
  });

  it('Table, with rows and empty', async () => {
    const columns = [{ key: 'slot', header: 'Slot', cell: (r: { slot: number }) => r.slot }];
    expect(
      await violations(
        <div>
          <Table
            caption="Samples"
            columns={columns}
            rows={[{ slot: 1 }, { slot: 2 }]}
            rowKey={(r) => String(r.slot)}
            empty="None"
          />
          <Table caption="Empty samples" columns={columns} rows={[]} rowKey={(r) => String(r.slot)} empty="None" />
        </div>,
      ),
    ).toEqual([]);
  });

  it('StepIndicator, all states', async () => {
    const states = ['done', 'current', 'upcoming', 'error'] as const;
    expect(
      await violations(
        <StepIndicator
          label="Flow"
          steps={FLOW_STEPS.slice(0, 4).map((s, i) => ({ title: s.title, state: states[i]! }))}
        />,
      ),
    ).toEqual([]);
  });

  it('Address and Did', async () => {
    expect(
      await violations(
        <div>
          <Address value={ADDRESS} />
          <Did value={`did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${ADDRESS}`} />
        </div>,
      ),
    ).toEqual([]);
  });

  it.each(Object.keys(TX_STAGES) as TxStage[])('TxConfirmation: %s', async (stage) => {
    expect(await violations(<TxConfirmation stage={stage} />)).toEqual([]);
  });

  it('ThemeToggle', async () => {
    expect(
      await violations(
        <ThemeProvider>
          <ThemeToggle />
        </ThemeProvider>,
      ),
    ).toEqual([]);
  });
});
