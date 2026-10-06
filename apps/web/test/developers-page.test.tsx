// @vitest-environment jsdom
// Geliştirici portalı (FE-22): yapılandırma ve cüzdan yokken sayfanın kapalı olması; cüzdanla oturum, API
// anahtarının oluşturulup sırrının bir kez gösterilmesi ve iptali, ücretli uç noktanın oluşturulması,
// pasifleştirilmesi ve kullanımı, örneklerin seçilen anahtar ve uç noktayla dolması; oturumun düşmesi;
// erişilebilirlik. API bellek içi sahte sunucudur (test/helpers/fake-square-api.ts), istemci SDK'nınkidir.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import DevelopersRoute from '@/app/app/developers/page';
import { DeveloperPortal } from '@/components/developers/developers-page';
import { Providers } from '@/components/providers';
import { USDC_MINTS } from '@/lib/developer-portal';
import { fakeSquareApi, testWallet } from './helpers/fake-square-api';

afterEach(cleanup);
// Yük altında (turbo paralel koşu) API yanıtları ve yeniden çizim 1 saniyeyi aşabilir.
configure({ asyncUtilTimeout: 8_000 });

const RPC = 'http://127.0.0.1:9';
const API = 'https://api.square.test';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;

const a11y = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

describe('/app/developers', () => {
  it('is unavailable without SQUARE_API_URL', () => {
    render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: {} }}>
        <DevelopersRoute />
      </Providers>,
    );
    expect(screen.getByText('SQUARE_API_URL')).toBeTruthy();
  });

  it('asks for a wallet', () => {
    render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: {}, apiUrl: API }}>
        <DevelopersRoute />
      </Providers>,
    );
    expect(screen.getByText('Connect a wallet to manage its API keys and paid endpoints.')).toBeTruthy();
  });
});

async function signedIn() {
  const fake = fakeSquareApi();
  const wallet = testWallet();
  const view = render(
    <DeveloperPortal
      apiUrl={API}
      cluster="devnet"
      wallet={wallet.address}
      signMessage={wallet.signMessage}
      fetch={fake.fetch}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with wallet' }));
  await screen.findByRole('button', { name: 'Sign out' });
  await screen.findByText('No API keys yet.');
  return { fake, wallet, ...view };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });

// axe ve tam form akışı yük altında birkaç saniye sürer.
describe('developer portal', { timeout: 30_000 }, () => {
  it('creates an API key, shows its secret once and revokes it', async () => {
    const { fake, container } = await signedIn();
    type('Label', 'report server');
    fireEvent.click(screen.getByRole('checkbox', { name: /x402:serve/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    await waitFor(() => expect(fake.keys).toHaveLength(1));
    const secret = fake.keys[0]?.secret;
    await screen.findByText(secret!);
    expect(fake.keys[0]).toMatchObject({ label: 'report server', scopes: ['read', 'x402:serve'] });
    const keys = screen.getByRole('region', { name: 'Your API keys' });
    expect(within(keys).getByText(`${secret!.slice(0, 12)}…`)).toBeTruthy();
    expect(within(keys).getAllByText('Never').length).toBe(1);
    expect(screen.getByRole('button', { name: 'Copy the API key secret' })).toBeTruthy();
    expect(await a11y(container)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByText(secret!)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke report server' }));
    await screen.findByText('No API keys yet.');
    expect(fake.keys).toEqual([]);
  });

  it('manages a paid endpoint, shows its usage and fills in the snippets', async () => {
    const { fake, wallet, container } = await signedIn();
    expect(field('Pay to').value).toBe(wallet.address);
    expect(field('Mint').value).toBe(USDC_MINTS[DEVNET]);
    type('Name', 'Daily report');
    type('Path', '/v1/report');
    type('Price per call (USDC)', '0.25');
    type('Description', 'Yesterday’s numbers');
    fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }));

    const endpoints = await screen.findByRole('region', { name: 'Paid endpoints' });
    await within(endpoints).findByText('Daily report');
    expect(fake.endpoints[0]).toMatchObject({
      name: 'Daily report',
      path: '/v1/report',
      amount: '250000',
      mint: USDC_MINTS[DEVNET],
      network: DEVNET,
      payTo: wallet.address,
      description: 'Yesterday’s numbers',
      enabled: true,
    });
    expect(within(endpoints).getByText('0.25 USDC')).toBeTruthy();
    // Oluşturulan uç nokta seçilir: kullanımı boş, örnekler onunla dolar.
    await screen.findByText('No payments yet. Your server reports each settled payment.');
    const id = fake.endpoints[0]!.id;
    const server = screen.getByLabelText('Charge for the endpoint on your server (TypeScript)');
    expect(server.textContent).toContain(`const ENDPOINT_ID = "${id}"`);
    expect(screen.getByLabelText('Pay for the endpoint from a client (TypeScript)').textContent).toContain(
      'createPayingFetch',
    );

    // Geliştiricinin sunucusunun bildirdiği ödeme kullanımda görünür.
    fake.payments.push({
      id: 'p1',
      endpointId: id,
      fingerprint: `svm:${'ab'.repeat(32)}`,
      transaction: '5'.repeat(88),
      network: DEVNET,
      asset: USDC_MINTS[DEVNET],
      amount: '250000',
      payer: wallet.address,
      payTo: wallet.address,
      settledAt: 1_791_300_000,
      reportedAt: 1_791_300_001,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    const usage = await screen.findByRole('region', { name: 'Recent payments for Daily report' });
    await within(usage).findByText('0.25 USDC');
    expect(screen.getByText('Paid calls').nextSibling?.textContent).toBe('1');

    // Snippet anahtar seçimi.
    type('Label', 'server');
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(fake.keys).toHaveLength(1));
    await screen.findByText(fake.keys[0]!.secret);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: fake.keys[0]!.id } });
    expect(server.textContent).toContain(`// API key "server" (${fake.keys[0]!.prefix}…)`);

    // Düzenleme ve pasifleştirme.
    fireEvent.click(within(endpoints).getByRole('button', { name: 'Edit Daily report' }));
    expect(field('Price per call (USDC)').value).toBe('0.25');
    type('Price per call (USDC)', '0.5');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await within(endpoints).findByText('0.5 USDC');
    fireEvent.click(within(endpoints).getByRole('button', { name: 'Disable Daily report' }));
    await within(endpoints).findByText('Disabled');
    expect(fake.endpoints[0]).toMatchObject({ amount: '500000', enabled: false });
    expect(await a11y(container)).toEqual([]);

    fireEvent.click(within(endpoints).getByRole('button', { name: 'Delete Daily report' }));
    await within(endpoints).findByText('No paid endpoints yet.');
    expect(fake.endpoints).toEqual([]);
  });

  it('shows field errors instead of sending an invalid endpoint', async () => {
    const { fake } = await signedIn();
    type('Path', 'report');
    type('Price per call (USDC)', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Create endpoint' }));
    expect(await screen.findByText('Enter a name.')).toBeTruthy();
    expect(screen.getByText('The price must be greater than zero.')).toBeTruthy();
    expect(field('Path').getAttribute('aria-invalid')).toBe('true');
    expect(fake.endpoints).toEqual([]);
  });

  it('signs out when the API no longer accepts the session', async () => {
    const { fake } = await signedIn();
    fake.expireSessions();
    type('Label', 'late');
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByText('The session is no longer valid. Sign in again.');
    expect(screen.getByRole('button', { name: 'Sign in with wallet' })).toBeTruthy();
  });

  it('explains a wallet that cannot sign messages', async () => {
    const fake = fakeSquareApi();
    render(
      <DeveloperPortal
        apiUrl={API}
        cluster="devnet"
        wallet={testWallet().address}
        signMessage={undefined}
        fetch={fake.fetch}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with wallet' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This wallet cannot sign messages, so it cannot sign in to the API.',
      ),
    );
  });
});
