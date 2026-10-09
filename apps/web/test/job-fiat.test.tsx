// @vitest-environment jsdom
// Fiat işin kartla ödeme bölümü (FE-20): herkesin gördüğü aşamalar (teslimde ödenecek, ödeme bekleniyor, ispat bağlı
// ve finalize edilebilir, release edildi), Square API'si ve Stripe'ın en düşük tutarı, kurumun oturumu, makbuzu ve
// ispat bağlanamıyorsa ödemenin açılmaması; erişilebilirlik. Hesaplar escrow IDL'iyle kodlanıp sahte zincirden okunur;
// API bellek içi sahte sunucudur (test/helpers/fake-square-api.ts). Stripe'a ve prover'a karşı akış PR'daki uçtan uca
// denemededir.
import './helpers/record-requests';
import { WalletContext, type WalletContextState } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { createPda, type JobAccount } from '@squaresdk/solana-sdk';
import type { FiatAttestation } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionProvider } from '@/components/api-session';
import { JobFiat } from '@/components/jobs/job-fiat';
import { Providers } from '@/components/providers';
import type { EscrowSetup } from '@/lib/job-wizard';
import type { ReleaseState } from '@/lib/release-proof';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { encodeConfig, fakeClient, FakeChain, jobAccount, key } from './helpers/escrow-accounts';
import { fakeSquareApi, testWallet, type FakeSquareApi, type TestWallet } from './helpers/fake-square-api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
configure({ asyncUtilTimeout: 8_000 });

const RPC = 'http://127.0.0.1:9';
const API = 'https://api.square.test';
const escrow = key();
const [agent, mint] = [key(), key()];
const jobKey = key();
const DAY = 86_400;
const NOW = 1_790_000_000 - (1_790_000_000 % DAY) + DAY / 2;
const AMOUNT = 12_500_000n;
const token = { mint, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6 };
const usdc = (base: bigint) => `${Number(base) / 1_000_000} USDC`;
const CONFIG = {
  currency: 'usd',
  publishableKey: 'pk_test_51SquareFiatRailExample',
  mppAuthority: key().toBase58(),
  mppNetworkId: null,
  minimumAmountMinor: 50,
} as const;

const a11y = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

async function setupWith(): Promise<EscrowSetup> {
  const chain = new FakeChain();
  const pda = createPda({ registry: key(), policy: key(), verifier: key(), escrow });
  chain.put(pda.escrowConfig()[0], await encodeConfig({ arbitrators: [key()], threshold: 1 }), escrow);
  return {
    client: fakeClient(chain, escrow),
    registryProgram: key(),
    policyProgram: key(),
    minChallengePeriod: 60n,
    maxChallengePeriod: 604_800n,
    travelRuleThreshold: 0n,
    keeperFeeBps: 50,
  };
}

const fiatJob = (institution: PublicKey, status: string, amount = AMOUNT) =>
  jobAccount({ institution, agent_wallet: agent, mint, status, policy: key(), rail: 'fiat', amount, settled_at: NOW });

const releaseState = (proof: ReleaseState['proof']): { state: 'ready'; value: ReleaseState } => ({
  state: 'ready',
  value: {
    proof,
    operator: { dailySpent: 0n, dayStartUnix: NOW - DAY / 2 },
    keeperFeeBps: 50,
    institution: key(),
    multisigVault: null,
  },
});

const connected = (address: string, signMessage: TestWallet['signMessage']) =>
  ({
    autoConnect: false,
    wallets: [],
    wallet: null,
    publicKey: new PublicKey(address),
    connecting: false,
    connected: true,
    disconnecting: false,
    select: () => undefined,
    connect: async () => undefined,
    disconnect: async () => undefined,
    sendTransaction: async () => {
      throw new Error('this test sends no transactions');
    },
    signTransaction: undefined,
    signAllTransactions: undefined,
    signMessage,
    signIn: undefined,
  }) as WalletContextState;

async function mount(params: {
  account: JobAccount;
  release?: ReturnType<typeof releaseState>;
  api?: FakeSquareApi | null;
  wallet?: TestWallet;
}) {
  const setup = await setupWith();
  if (params.api) vi.stubGlobal('fetch', params.api.fetch);
  const section = (
    <JobFiat
      escrow={setup}
      jobKey={jobKey}
      account={params.account}
      release={params.release ?? releaseState(null)}
      chainNow={NOW}
      revision={0}
      token={token}
      formatAmount={usdc}
      onConfirmed={() => undefined}
    />
  );
  const config = { cluster: 'devnet', rpcUrl: RPC, programIds: { escrow: escrow.toBase58() } } as const;
  return render(
    <Providers config={params.api === null ? config : { ...config, apiUrl: API }}>
      <main>
        {params.wallet ? (
          <WalletContext.Provider value={connected(params.wallet.address, params.wallet.signMessage)}>
            <ApiSessionProvider apiUrl={API}>{section}</ApiSessionProvider>
          </WalletContext.Provider>
        ) : (
          section
        )}
      </main>
    </Providers>,
  );
}

const withConfig = () => {
  const api = fakeSquareApi();
  api.fiat.config = { ...CONFIG };
  return api;
};

describe('card payment section, as anyone', () => {
  it('is due on delivery; there is no escrow, challenge window or dispute', { timeout: 20000 }, async () => {
    const { container } = await mount({ account: await fiatJob(key(), 'accepted'), api: withConfig() });
    expect(screen.getByText('Due on delivery')).toBeTruthy();
    expect(await screen.findByText('$12.50')).toBeTruthy();
    expect(screen.getByText("Square's Stripe account")).toBeTruthy();
    expect(screen.getByText(/There is no escrow, challenge window or dispute/)).toBeTruthy();
    expect(await a11y(container)).toEqual([]);
  });

  it('waits for the institution once the work is delivered', async () => {
    await mount({ account: await fiatJob(key(), 'delivered'), api: withConfig() });
    expect(screen.getByText('Awaiting payment')).toBeTruthy();
    expect(
      screen.getByText('Delivered. Waiting for the institution to pay by card and bind its compliance proof.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
  });

  it('lets anyone finalize once the proof of the payment is bound and fresh', { timeout: 20000 }, async () => {
    const proof = {
      payee: agent,
      netAmount: AMOUNT,
      mint,
      dailySpentBefore: 0n,
      proofTimestamp: NOW - 60,
      compliant: true,
      refusalCode: 0,
      consumed: false,
    };
    const { container } = await mount({
      account: await fiatJob(key(), 'delivered'),
      release: releaseState(proof),
      api: withConfig(),
    });
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText(/anyone can finalize the job now/)).toBeTruthy();
    expect(screen.getByText('Connect a wallet to finalize.')).toBeTruthy();
    expect(await a11y(container)).toEqual([]);
  });

  it('shows the release and its validation record', async () => {
    await mount({ account: await fiatJob(key(), 'released'), api: withConfig() });
    expect(screen.getByText('Released', { selector: 'span' })).toBeTruthy();
    expect(await screen.findByText('No validation record on chain.')).toBeTruthy();
  });

  it('needs the Square API, and an amount Stripe accepts', async () => {
    await mount({ account: await fiatJob(key(), 'delivered'), api: null });
    expect(screen.getByText(/Card payments go through the Square API, and/)).toBeTruthy();
    cleanup();
    await mount({ account: await fiatJob(key(), 'delivered', 400_000n), api: withConfig() });
    expect(await screen.findByText('This job cannot be paid by card: Card payments start at $0.50.')).toBeTruthy();
  });
});

describe('card payment section, as the institution', () => {
  const attestation = (institution: string): FiatAttestation => ({
    job: jobKey.toBase58(),
    institution,
    amount: AMOUNT.toString(),
    paymentIntent: 'pi_3QSquareFiatReceipt',
    amountMinor: 1_250,
    currency: 'usd',
    customer: 'cus_SquareInstitution',
    paidAt: NOW - 300,
    receiptHash: 'ab'.repeat(32),
    authority: CONFIG.mppAuthority,
    signature: bs58.encode(new Uint8Array(64).fill(3)),
    source: 'webhook',
  });

  it('signs in, and offers no payment when the proof could not be bound', { timeout: 20000 }, async () => {
    const wallet = testWallet();
    const { container } = await mount({
      account: await fiatJob(new PublicKey(wallet.address), 'delivered'),
      api: withConfig(),
      wallet,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to the Square API' }));
    // Prover yapılandırılmamış: ispat bu sayfadan bağlanamaz, ödeme açılmaz.
    expect(await screen.findByText(/Paying is not offered here/)).toBeTruthy();
    expect(screen.getByText('SQUARE_PROVER_URL')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
    expect(await a11y(container)).toEqual([]);
  });

  it('reads the receipt of a paid job', { timeout: 20000 }, async () => {
    const wallet = testWallet();
    const api = withConfig();
    api.fiat.attestations.set(jobKey.toBase58(), attestation(wallet.address));
    await mount({ account: await fiatJob(new PublicKey(wallet.address), 'delivered'), api, wallet });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to the Square API' }));
    expect(await screen.findByText('pi_3QSquareFiatReceipt')).toBeTruthy();
    expect(screen.getByText('ab'.repeat(32))).toBeTruthy();
    expect(screen.getByText("from Stripe's signed webhook")).toBeTruthy();
    // Rozet ve makbuzun "Paid" satırı.
    expect(screen.getAllByText('Paid')).toHaveLength(2);
    // İşin tutarı ve makbuzdaki ödenen tutar.
    expect(screen.getAllByText('$12.50')).toHaveLength(2);
  });
});
