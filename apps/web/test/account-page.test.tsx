// @vitest-environment jsdom
// Hesap sayfası ve rolün hesabı (FE-21): yapılandırma koşulları, sponsorlu gönderim tercihi, smart account taslağının
// denetimi, rol seçimi ve sayfaların rol adına çalıştığı adres. Sayfalar gerçek Providers ile render edilir; RPC
// yerelde dinlenmeyen bir adrestir (ağ doğrulanamadığından işlem gönderilmez).
import { WalletContext, type WalletContextState } from '@solana/wallet-adapter-react';
import { squadsVaultAddress } from '@squaresdk/solana-sdk/squads';
import { Keypair, PublicKey } from '@solana/web3.js';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AccountRoute from '@/app/app/account/page';
import PolicyRoute from '@/app/app/policy/page';
import { ActorProvider } from '@/components/actor';
import { ApiSessionProvider } from '@/components/api-session';
import { Providers } from '@/components/providers';
import { RoleProvider } from '@/components/role-provider';
import type { WebConfig } from '@/lib/config';
import type { Role } from '@/lib/roles';

configure({ asyncUtilTimeout: 8_000 });

const RPC = 'http://127.0.0.1:9';
const API = 'https://api.square.test';
const FEE_PAYER = 'https://sponsor.square.test';
const policy = Keypair.generate().publicKey.toBase58();
const sponsored: WebConfig = {
  cluster: 'devnet',
  rpcUrl: RPC,
  programIds: { policy },
  apiUrl: API,
  feePayerUrl: FEE_PAYER,
};

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const connected = (address: PublicKey) =>
  ({
    autoConnect: false,
    wallets: [],
    wallet: null,
    publicKey: address,
    connecting: false,
    connected: true,
    disconnecting: false,
    select: () => undefined,
    connect: async () => undefined,
    disconnect: async () => undefined,
    sendTransaction: async () => {
      throw new Error('the test sends no transactions');
    },
    signTransaction: undefined,
    signAllTransactions: undefined,
    signMessage: undefined,
    signIn: undefined,
  }) as WalletContextState;

/** Cüzdanı bağlı sayfa: cüzdana bağlı sağlayıcılar test cüzdanının içinde yeniden kurulur. */
function mount(config: WebConfig, wallet: PublicKey, role: Role | null, page: ReactNode) {
  if (role) window.localStorage.setItem(`square-role:${wallet.toBase58()}`, role);
  return render(
    <Providers config={config}>
      <WalletContext.Provider value={connected(wallet)}>
        <RoleProvider>
          <ApiSessionProvider apiUrl={config.apiUrl}>
            <ActorProvider>{page}</ActorProvider>
          </ApiSessionProvider>
        </RoleProvider>
      </WalletContext.Provider>
    </Providers>,
  );
}

const a11y = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

describe('/app/account', () => {
  it('asks for a wallet', () => {
    render(
      <Providers config={sponsored}>
        <AccountRoute />
      </Providers>,
    );
    expect(screen.getByText(/Connect a wallet to choose how it pays/)).toBeTruthy();
  });

  it('says the sponsor is not configured and offers no smart account without SQUARE_FEE_PAYER_URL', () => {
    const wallet = Keypair.generate().publicKey;
    mount({ ...sponsored, feePayerUrl: undefined } as WebConfig, wallet, 'institution', <AccountRoute />);
    expect(
      screen.getByText(
        'Unavailable: SQUARE_FEE_PAYER_URL is not set, so transactions cannot be sponsored. This wallet pays its own fees.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open the smart account' })).toBeNull();
  });

  it('keeps the sponsorship choice per wallet and checks the smart account draft', async () => {
    const wallet = Keypair.generate().publicKey;
    const { container } = mount(sponsored, wallet, 'institution', <AccountRoute />);
    expect(screen.getByRole('heading', { name: 'Smart account for the Institution role' })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: /The sponsor pays this wallet/ }));
    expect(window.localStorage.getItem(`square-sponsored:${wallet.toBase58()}`)).toBe('1');

    const others = screen.getByLabelText('Other members (optional)');
    const threshold = screen.getByLabelText('Approvals needed');
    fireEvent.change(others, { target: { value: wallet.toBase58() } });
    expect(screen.getByText('A member is listed twice.')).toBeTruthy();
    fireEvent.change(others, { target: { value: Keypair.generate().publicKey.toBase58() } });
    fireEvent.change(threshold, { target: { value: '3' } });
    expect(screen.getByText('The threshold is at most the number of members (2).')).toBeTruthy();
    fireEvent.change(threshold, { target: { value: '2' } });
    expect(screen.queryByText(/The threshold is at most/)).toBeNull();
    // Ağ doğrulanamadığından açılış gönderilmez.
    expect(screen.getByRole('button', { name: 'Open the smart account' }).hasAttribute('disabled')).toBe(true);
    expect(await a11y(container)).toEqual([]);
  });

  it('offers smart accounts only to the institution, agent and buyer roles', () => {
    mount(sponsored, Keypair.generate().publicKey, 'arbitrator', <AccountRoute />);
    expect(screen.getByText(/Smart accounts are for the Institution, Agent and Buyer roles/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Smart account for/ })).toBeNull();
  });

  it('reads the chosen smart account once the network is verified', () => {
    const wallet = Keypair.generate().publicKey;
    window.localStorage.setItem(
      `square-smart-account:${wallet.toBase58()}:agent`,
      Keypair.generate().publicKey.toBase58(),
    );
    mount(sponsored, wallet, 'agent', <AccountRoute />);
    expect(screen.getByText('Verifying the network before reading the account…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open the smart account' })).toBeNull();
  });
});

describe('the role acts as', () => {
  it('the wallet by default: no notice on the policy page', () => {
    mount(sponsored, Keypair.generate().publicKey, 'institution', <PolicyRoute />);
    expect(screen.queryByText(/Acting as the smart account vault/)).toBeNull();
    expect(screen.queryByText(/The sponsor pays the fees and rent/)).toBeNull();
  });

  it('the sponsored wallet when the wallet chose the sponsor', () => {
    const wallet = Keypair.generate().publicKey;
    window.localStorage.setItem(`square-sponsored:${wallet.toBase58()}`, '1');
    mount(sponsored, wallet, 'institution', <PolicyRoute />);
    expect(screen.getByText(/The sponsor pays the fees and rent of this wallet's transactions/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage the account' }).getAttribute('href')).toBe('/app/account');
  });

  it('the vault of the role’s smart account, whose address the policy is written for', () => {
    const wallet = Keypair.generate().publicKey;
    const multisig = Keypair.generate().publicKey;
    window.localStorage.setItem(`square-smart-account:${wallet.toBase58()}:institution`, multisig.toBase58());
    mount(sponsored, wallet, 'institution', <PolicyRoute />);
    const vault = squadsVaultAddress(multisig, 0)[0].toBase58();
    const notice = screen.getByText(/Acting as the smart account vault/);
    expect(notice.textContent).toContain(vault);
    // Başka rolün seçimi bu rolü etkilemez.
    cleanup();
    mount(sponsored, wallet, 'agent', <PolicyRoute />);
    expect(screen.queryByText(/Acting as the smart account vault/)).toBeNull();
  });

  it('reports a smart account chosen while the sponsor is not configured', () => {
    const wallet = Keypair.generate().publicKey;
    window.localStorage.setItem(
      `square-smart-account:${wallet.toBase58()}:institution`,
      Keypair.generate().publicKey.toBase58(),
    );
    mount({ ...sponsored, feePayerUrl: undefined } as WebConfig, wallet, 'institution', <PolicyRoute />);
    expect(screen.getByText(/SQUARE_FEE_PAYER_URL is not set, so transactions cannot be sponsored/)).toBeTruthy();
  });
});
