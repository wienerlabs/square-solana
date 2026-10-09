// @vitest-environment jsdom
// Docs: her bölüm görünür ve menüden bağlanır; program adresleri ve API sözleşmesinin bağlantısı dağıtımın
// yapılandırmasından gelir; axe ihlali yok. RPC yerelde dinlenmeyen bir adrestir.
import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DOC_SECTIONS } from '@/components/docs/content';
import { DocsPage } from '@/components/docs/docs-page';
import { Providers } from '@/components/providers';

afterEach(cleanup);

const CONFIG = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:9', programIds: {} } as const;

const mount = (config: Parameters<typeof Providers>[0]['config'] = CONFIG) =>
  render(
    <Providers config={config}>
      <DocsPage />
    </Providers>,
  );

describe('docs', () => {
  it('shows every section and links each one from the menu', () => {
    mount();
    const menu = screen.getByRole('navigation', { name: 'Docs' });
    const links = within(menu).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(DOC_SECTIONS.map((s) => `#${s.id}`));
    for (const section of DOC_SECTIONS) {
      expect(screen.getByRole('region', { name: section.title }).id).toBe(section.id);
    }
  });

  it('reads the program addresses from the configuration and says which are missing', () => {
    const escrow = '6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX';
    mount({ ...CONFIG, programIds: { escrow } });
    const programs = screen.getByRole('region', { name: 'Programs' });
    expect(within(programs).getAllByText('Not configured')).toHaveLength(3);
    expect(within(programs).getByRole('button', { name: 'Copy square_escrow address' })).toBeTruthy();
  });

  it('links the API contract only when a Square API is configured', () => {
    mount();
    const developers = screen.getByRole('region', { name: 'For developers' });
    expect(within(developers).getByText(/no Square API configured/)).toBeTruthy();
    cleanup();
    mount({ ...CONFIG, apiUrl: 'http://127.0.0.1:9' });
    const link = within(screen.getByRole('region', { name: 'For developers' })).getByRole('link', {
      name: 'http://127.0.0.1:9/openapi.json',
    });
    expect(link.getAttribute('href')).toBe('http://127.0.0.1:9/openapi.json');
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
