// @vitest-environment jsdom
// Agent dizini ve profili sayfaları (FE-05): API tanımlı değilken kapalı olmaları, ağ doğrulanmadan API'nin
// okunmaması, erişilebilirlik. RPC ve API yerelde dinlenmeyen adreslerdir; sahte zincir verisi kullanılmaz.
import { requests } from './helpers/record-requests';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AgentsRoute from '@/app/app/agents/page';
import AgentRoute from '@/app/app/agents/[agentRecord]/page';
import { Providers } from '@/components/providers';

const RPC = 'http://127.0.0.1:9';
const API = 'http://127.0.0.1:10';

beforeEach(() => {
  requests.length = 0;
});
afterEach(cleanup);

const a11y = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

describe('/app/agents', () => {
  it('is unavailable without the Square API', () => {
    render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: {} }}>
        <AgentsRoute />
      </Providers>,
    );
    expect(screen.getByText('SQUARE_API_URL')).toBeTruthy();
  });

  it('reads no agent until the network is verified', { timeout: 20000 }, async () => {
    const { container } = render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: {}, apiUrl: API }}>
        <AgentsRoute />
      </Providers>,
    );
    await screen.findByText('The network is not verified, so the directory is not read.', undefined, {
      timeout: 8000,
    });
    // Ağa giden tek istek genesis sorgusu; API'ye istek gitmedi.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.includes('getGenesisHash'))).toBe(true);
    expect(await a11y(container)).toEqual([]);
  });
});

describe('/app/agents/[agentRecord]', () => {
  it('refuses an address that is not an agent record', async () => {
    render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: {}, apiUrl: API }}>
        {await AgentRoute({ params: Promise.resolve({ agentRecord: 'not-an-address' }) })}
      </Providers>,
    );
    expect(screen.getByText('This is not an agent record address.')).toBeTruthy();
  });

  it('reads no agent until the network is verified', { timeout: 20000 }, async () => {
    const agentRecord = Keypair.generate().publicKey.toBase58();
    const { container } = render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: {}, apiUrl: API }}>
        {await AgentRoute({ params: Promise.resolve({ agentRecord }) })}
      </Providers>,
    );
    await screen.findByText('The network is not verified, so the agent is not read.', undefined, { timeout: 8000 });
    expect(requests.every((request) => request.includes('getGenesisHash'))).toBe(true);
    expect(await a11y(container)).toEqual([]);
  });
});
