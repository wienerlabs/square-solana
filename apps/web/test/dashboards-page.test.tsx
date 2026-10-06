// @vitest-environment jsdom
// Rol panelleri ve ağ sayfası (FE-11): API ve escrow yapılandırılmadan açılmamaları, ağ doğrulanmadan zincirin ve
// API'nin okunmaması, cüzdansız panelin boş kalması, erişilebilirlik. RPC ve API yerelde dinlenmeyen adreslerdir;
// sahte zincir verisi kullanılmaz.
import { requests } from './helpers/record-requests';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Keypair } from '@solana/web3.js';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import NetworkRoute from '@/app/app/network/page';
import AgentDashboard from '@/components/dashboard/agent-dashboard';
import BuyerDashboard from '@/components/dashboard/buyer-dashboard';
import InstitutionDashboard from '@/components/dashboard/institution-dashboard';
import { RoleDashboard } from '@/components/dashboard/role-dashboard';
import { Providers } from '@/components/providers';
import type { WebConfig } from '@/lib/config';

const RPC = 'http://127.0.0.1:9';
const API = 'http://127.0.0.1:10';
const key = () => Keypair.generate().publicKey.toBase58();
const programIds = { registry: key(), policy: key(), verifier: key(), escrow: key() };
const owner = key();

beforeEach(() => {
  requests.length = 0;
});
afterEach(cleanup);

/** Ağ doğrulanmadan yalnızca genesis sorgusu (ağ koruması) ve ağ panelinin slot'u okunur. */
const onlyNetworkCheck = () =>
  requests.filter((request) => !request.includes('getGenesisHash') && !request.includes('getSlot'));

const accessibility = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

const PANELS: [string, ComponentType<{ owner: string }>][] = [
  ['institution', InstitutionDashboard],
  ['agent', AgentDashboard],
  ['buyer', BuyerDashboard],
];

describe('role panels', () => {
  it('need the Square API and the escrow program', () => {
    const config = (fields: Partial<WebConfig>): WebConfig => ({
      cluster: 'devnet',
      rpcUrl: RPC,
      programIds,
      ...fields,
    });
    render(
      <Providers config={config({})}>
        <InstitutionDashboard owner={owner} />
      </Providers>,
    );
    expect(screen.getByText('SQUARE_API_URL')).toBeTruthy();
    cleanup();
    render(
      <Providers config={config({ apiUrl: API, programIds: {} })}>
        <BuyerDashboard owner={owner} />
      </Providers>,
    );
    expect(screen.getByText('SQUARE_PROGRAM_ID_ESCROW')).toBeTruthy();
  });

  for (const [subject, Panel] of PANELS) {
    it(`read neither the chain nor the API until the network is verified: ${subject}`, { timeout: 20000 }, async () => {
      const { container } = render(
        <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds, apiUrl: API }}>
          <Panel owner={owner} />
        </Providers>,
      );
      await screen.findByText(`The network is not verified, so the ${subject} panel is not read.`, undefined, {
        timeout: 8000,
      });
      expect(requests.length).toBeGreaterThan(0);
      expect(onlyNetworkCheck()).toEqual([]);
      expect(await accessibility(container)).toEqual([]);
    });
  }

  it('shows nothing without a connected wallet', () => {
    const { container } = render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds, apiUrl: API }}>
        <RoleDashboard />
      </Providers>,
    );
    expect(container.textContent).toBe('');
  });
});

describe('/app/network', () => {
  it('reads no program, config, table or API until the network is verified', { timeout: 20000 }, async () => {
    const { container } = render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds, apiUrl: API, lookupTable: key() }}>
        {NetworkRoute()}
      </Providers>,
    );
    await screen.findByText('The network is not verified, so the programs are not read.', undefined, {
      timeout: 8000,
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Network' })).toBeTruthy();
    expect(onlyNetworkCheck()).toEqual([]);
    expect(await accessibility(container)).toEqual([]);
  });
});
