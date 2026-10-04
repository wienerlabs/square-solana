// @vitest-environment jsdom
// Agent kaydı ve DID çözümü sayfaları (FE-05): giriş koşulları, alan denetimleri, ağ doğrulanmadan DID
// türetilmemesi ve tx'in açılmaması, erişilebilirlik. RPC yerelde dinlenmeyen bir adrestir; sahte zincir
// verisi kullanılmaz. Kayıt adresi, DID ve talimat agent.test.ts'te ağsız denenir.
import { requests } from './helpers/record-requests';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AgentRoute from '@/app/app/agent/page';
import { AgentRegistration } from '@/components/agent/agent-registration';
import { DidResolver } from '@/components/did/did-resolver';
import { Providers } from '@/components/providers';

const RPC = 'http://127.0.0.1:9';
const registry = Keypair.generate().publicKey.toBase58();
const owner = Keypair.generate().publicKey.toBase58();
const CONFIG = { cluster: 'devnet', rpcUrl: RPC, programIds: { registry } } as const;

beforeEach(() => {
  window.localStorage.clear();
  requests.length = 0;
});
afterEach(cleanup);

const axeViolations = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, value: string) => fireEvent.change(field(label), { target: { value } });

describe('/app/agent gate', () => {
  it('asks for the owner wallet first', () => {
    render(
      <Providers config={CONFIG}>
        <AgentRoute />
      </Providers>,
    );
    expect(screen.getByText(/Connect the wallet that will own the agent/)).toBeTruthy();
  });
});

describe('agent registration', () => {
  const mount = () =>
    render(
      <Providers config={CONFIG}>
        <main>
          <AgentRegistration owner={owner} registryProgramId={registry} />
        </main>
      </Providers>,
    );

  it('checks the fields as they are typed', async () => {
    mount();
    type(/Agent ID/, 'alpha agent');
    expect(screen.getByText('Use only letters, digits, "_" and "-".')).toBeTruthy();
    expect(field(/Agent ID/).getAttribute('aria-invalid')).toBe('true');
    type(/Agent ID/, 'x'.repeat(33));
    expect(screen.getByText('The agent ID is at most 32 characters.')).toBeTruthy();

    type(/Agent card URI/, 'http://agents.square.test/card.json');
    expect(screen.getByText('The card must be served over https.')).toBeTruthy();
    type(/Agent card URI/, '');
    expect(screen.getByText('empty (no card)')).toBeTruthy();

    // Varsayılan agent cüzdanı bağlı cüzdandır.
    expect(field(/^Wallet/).value).toBe(owner);
    type(/^Wallet/, 'not-an-address');
    expect(screen.getByText('Enter a Solana address.')).toBeTruthy();
  });

  it('derives no DID and opens no transaction until the network is verified', { timeout: 20000 }, async () => {
    const { container } = mount();
    type(/Agent ID/, 'alpha-01');
    await screen.findByText(/^The network cannot be verified: /, undefined, { timeout: 8000 });
    expect(screen.queryByText('DID')).toBeNull();
    expect(screen.queryByText('Card entry for this agent')).toBeNull();
    const register = screen.getByRole('button', { name: 'Register the agent' }) as HTMLButtonElement;
    expect(register.disabled).toBe(true);
    expect(screen.getByText(/The network cannot be verified because the RPC failed/)).toBeTruthy();
    // Ağa giden tek istek genesis sorgusu; kayıt okunmadı, tx gönderilmedi.
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests.every((request) => request.includes('getGenesisHash'))).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('DID resolver', () => {
  const did = `did:aip:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${registry}:${owner}`;

  it('keeps the shared DID and waits for the network', { timeout: 20000 }, async () => {
    const { container } = render(
      <Providers config={CONFIG}>
        <main>
          <DidResolver initialDid={did} />
        </main>
      </Providers>,
    );
    expect(field(/did:aip identifier/).value).toBe(did);
    await screen.findByText(/The network cannot be verified/, undefined, { timeout: 8000 });
    expect((screen.getByRole('button', { name: 'Resolve' }) as HTMLButtonElement).disabled).toBe(true);
    // Çözüm bağlantının zincirine bağlıdır: ağ doğrulanmadan hesap okunmaz.
    expect(requests.every((request) => request.includes('getGenesisHash'))).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });
});
