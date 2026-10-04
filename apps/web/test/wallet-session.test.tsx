// @vitest-environment jsdom
// Cüzdan oturumu (FE-03): roller ve adımları, cüzdan başına rol kaydı, ağ doğrulanamayınca işlem
// kapanması ve /app sayfasının erişilebilirliği. RPC olarak yerelde dinlenmeyen bir adres verilir:
// canlı bölümler hata durumuna düşer, sahte veri kullanılmaz.
import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AppPage from '@/app/app/page';
import { NetworkBanner } from '@/components/network-banner';
import { Providers } from '@/components/providers';
import { ROLES, ROLE_INFO, readRole, roleSteps, writeRole } from '@/lib/roles';

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const CONFIG = { cluster: 'devnet', rpcUrl: 'http://127.0.0.1:9', programIds: {} } as const;

const mount = () =>
  render(
    <Providers config={CONFIG}>
      <NetworkBanner />
      <AppPage />
    </Providers>,
  );

describe('roles', () => {
  it('takes each role’s steps from the flow', () => {
    expect(roleSteps('institution')).toEqual([1, 3, 7]);
    expect(roleSteps('agent')).toEqual([2, 4, 5]);
    expect(roleSteps('buyer')).toEqual([5]);
  });

  it('remembers the role per wallet', () => {
    const [a, b] = ['wallet-a', 'wallet-b'];
    writeRole(a, 'institution');
    writeRole(b, 'buyer');
    expect(readRole(a)).toBe('institution');
    expect(readRole(b)).toBe('buyer');
    expect(readRole('wallet-c')).toBeNull();
  });

  it('ignores a stored value that is not a role', () => {
    window.localStorage.setItem('square-role:wallet-a', 'arbitrator');
    expect(readRole('wallet-a')).toBeNull();
  });
});

describe('/app without a wallet', () => {
  it('offers the three roles but keeps them disabled until a wallet connects', () => {
    mount();
    const group = screen.getByRole('group', { name: 'Role for this wallet' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual([...ROLES]);
    // Devre dışılık fieldset'ten gelir (HTML'de :disabled), girdinin kendi özniteliğinden değil.
    for (const radio of radios) expect(radio.matches(':disabled')).toBe(true);
    for (const role of ROLES) expect(within(group).getByText(ROLE_INFO[role].label)).toBeTruthy();
    expect(screen.getByText('Connect a wallet to choose a role.')).toBeTruthy();
  });

  it('disables transactions when the network cannot be verified', async () => {
    mount();
    const banner = await screen.findByText('Transactions are disabled', {}, { timeout: 5000 });
    expect(banner.closest('[role="alert"]')?.textContent).toMatch(
      /The network cannot be verified because the RPC failed/,
    );
    expect(screen.getAllByText('RPC error').length).toBeGreaterThan(0);
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
