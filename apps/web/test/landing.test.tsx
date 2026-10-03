// @vitest-environment jsdom
// Landing (FE-15): her buton ve bağlantı uygulamaya götürür; sekiz adımın hepsi görünür; axe ihlali yok.
// RPC olarak yerelde dinlenmeyen bir adres verilir: canlı bölümler hata durumuna düşer, sahte veri kullanılmaz.
import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import LandingPage from '@/app/page';
import { Providers } from '@/components/providers';
import { FLOW_STEPS } from '@/lib/flow';

afterEach(cleanup);

const CONFIG = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:9', programIds: {} } as const;

const mount = () =>
  render(
    <Providers config={CONFIG}>
      <LandingPage />
    </Providers>,
  );

describe('landing', () => {
  it('sends every link and button into the app', () => {
    const { container } = mount();
    const links = [...container.querySelectorAll('a')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute('href'), link.textContent ?? '').toMatch(/^\/app(\/|$)/);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('states the cluster it is configured for', () => {
    mount();
    expect(screen.getByText(/Square on Solana/).textContent).toContain('localnet');
  });

  it('shows all eight steps in order', () => {
    mount();
    const flow = screen.getByRole('region', { name: 'From mandate to payment' });
    const steps = within(flow).getAllByRole('listitem');
    expect(steps.map((s) => within(s).getByRole('heading').textContent)).toEqual(
      FLOW_STEPS.map((s) => `Step ${s.number}: ${s.title}`),
    );
  });

  it('lists the four programs and says which are not configured', () => {
    mount();
    const programs = screen.getByRole('region', { name: 'Programs' });
    for (const name of ['square_registry', 'square_policy', 'square_verifier', 'square_escrow']) {
      expect(within(programs).getByText(name)).toBeTruthy();
    }
    expect(within(programs).getAllByText('Not configured')).toHaveLength(4);
  });

  it('shows a configured program with its address and its on-chain state', async () => {
    // Gerçek bir adres (devnet USDC mint'i); biçim ve görünüm için. RPC'ye ulaşılamadığı için durum hata olur.
    const address = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    render(
      <Providers config={{ ...CONFIG, programIds: { registry: address } }}>
        <LandingPage />
      </Providers>,
    );
    const programs = screen.getByRole('region', { name: 'Programs' });
    expect(within(programs).getAllByText('Not configured')).toHaveLength(3);
    expect(within(programs).getByText(address)).toBeTruthy();
    expect(await within(programs).findByText('RPC error', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('passes axe (WCAG 2.2 A/AA)', async () => {
    const { container } = mount();
    const result = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
