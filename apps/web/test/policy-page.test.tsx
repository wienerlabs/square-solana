// @vitest-environment jsdom
// Politika sayfası (FE-04): giriş koşulları, kural editörü ve "politika içeriği sunucuya gönderilmiyor"
// kriteri. Sayfa gerçek Providers ile render edilir; RPC yerelde dinlenmeyen bir adrestir. Bütün HTTP
// istekleri kaydedilir (istek yine gerçekten gönderilir) ve hiçbirinde politikanın ya da sırrın izi aranır.
import { requests } from './helpers/record-requests';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PolicyRoute from '@/app/app/policy/page';
import { InstitutionPolicies } from '@/components/policy/institution-policies';
import { Providers } from '@/components/providers';

const RPC = 'http://127.0.0.1:9';
const policyProgram = Keypair.generate().publicKey.toBase58();
const owner = Keypair.generate().publicKey.toBase58();

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

describe('/app/policy gate', () => {
  it('asks for the institution wallet first', () => {
    render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: { policy: policyProgram } }}>
        <PolicyRoute />
      </Providers>,
    );
    expect(screen.getByText(/Connect the institution's wallet/)).toBeTruthy();
  });
});

describe('institution policies', () => {
  const mount = () =>
    render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: { policy: policyProgram } }}>
        <main>
          <InstitutionPolicies owner={owner} policyProgramId={policyProgram} />
        </main>
      </Providers>,
    );

  const input = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
  const type = (label: RegExp, value: string) => fireEvent.change(input(label), { target: { value } });

  it('computes the commitment in the browser and sends none of the policy anywhere', { timeout: 20000 }, async () => {
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a secret' }));
    fireEvent.click(screen.getByRole('button', { name: 'New policy' }));

    const mint = Keypair.generate().publicKey.toBase58();
    const blocked = Keypair.generate().publicKey.toBase58();
    const buyer = Keypair.generate().publicKey.toBase58();
    type(/Per-transaction limit/, '250000000');
    type(/^Daily limit/, '987654321');
    type(/Public daily ceiling/, '1000000000');
    type(/Token whitelist/, mint);
    type(/Blocked payees/, blocked);
    type(/Allowed payment categories/, 'confidential-research');
    type(/Approved buyers/, buyer);

    const preview = await screen.findByRole('region', { name: 'What goes on chain' });
    // policy_id, commitment ve buyer_root: üçü de bu tarayıcıda hesaplanan 32 baytlık değerler.
    await waitFor(() => expect(within(preview).getAllByText(/^[0-9a-f]{64}$/, { selector: 'code' })).toHaveLength(3), {
      timeout: 8000,
    });
    expect(within(preview).getByText('1000000000')).toBeTruthy();
    const commitment = within(preview).getByText('Policy commitment').nextElementSibling!;
    expect(commitment.textContent).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment.textContent).not.toBe('0'.repeat(64));

    const stored = window.localStorage.getItem(`square-policy-secret:${owner}`)!;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // En az bir RPC isteği (ağ koruması) kaydedildi; hiçbirinde sır ya da gizli kurallar yok.
    expect(requests.length).toBeGreaterThan(0);
    for (const secretValue of [stored, '987654321', '250000000', 'confidential-research', mint, blocked, buyer]) {
      for (const request of requests) expect(request).not.toContain(secretValue);
    }
    expect(await axeViolations(container)).toEqual([]);
  });

  it('reads and commits nothing on chain until the network is verified', { timeout: 20000 }, async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a secret' }));
    fireEvent.click(screen.getByRole('button', { name: 'New policy' }));
    const onChain = await screen.findByRole('region', { name: 'On chain' });
    await within(onChain).findByText(/The network is not verified/, undefined, { timeout: 8000 });
    expect((within(onChain).getByRole('button', { name: 'Commit on chain' }) as HTMLButtonElement).disabled).toBe(true);
    // Kurum ve politika hesapları okunmadı: ağa giden tek istek genesis sorgusu.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.includes('getGenesisHash'))).toBe(true);
  });

  it('keeps the commitment empty until the rules are complete', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a secret' }));
    fireEvent.click(screen.getByRole('button', { name: 'New policy' }));
    const preview = await screen.findByRole('region', { name: 'What goes on chain' });
    expect(within(preview).getByText('Complete the rules to compute the commitment.')).toBeTruthy();
    expect(screen.getAllByText('Required.')).toHaveLength(3);
  });

  it('remembers the secret and the draft for this wallet', async () => {
    const first = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a secret' }));
    fireEvent.click(screen.getByRole('button', { name: 'New policy' }));
    type(/^Daily limit/, '5000');
    first.unmount();

    mount();
    expect(await screen.findByRole('button', { name: 'Download backup' })).toBeTruthy();
    expect(input(/^Daily limit/).value).toBe('5000');
  });
});
