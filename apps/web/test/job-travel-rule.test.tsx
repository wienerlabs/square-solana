// @vitest-environment jsdom
// İş sayfasının Travel Rule bölümü (FE-18): herkese açık durum, kurum için şifreli depo, form ve
// commitment'ın yerel kayıtla doğrulanması; kişisel verinin hiçbir isteğe girmemesi. Bölüm gerçek Providers
// ile render edilir; RPC yerelde dinlenmeyen bir adrestir, bütün HTTP istekleri kaydedilir.
import { requests } from './helpers/record-requests';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { Connection, Keypair, type PublicKey } from '@solana/web3.js';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobTravelRule, type TravelRuleJob } from '@/components/jobs/job-travel-rule';
import { Providers } from '@/components/providers';
import type { EscrowSetup } from '@/lib/job-wizard';
import { hexToBytes } from '@/lib/policy-draft';
import { createTravelRuleEntry } from '@/lib/travel-rule';
import { createVaultKey, saveVault, sealVault } from '@/lib/travel-rule-local';
import { useTravelRuleVault } from '@/lib/use-travel-rule-vault';

const RPC = 'http://127.0.0.1:9';
const key = () => Keypair.generate().publicKey;
const escrow = key();
const institution = key();
const jobKey = key();
const PASSPHRASE = `travel rule ${Math.random().toString(36).slice(2)}`;
const CONFIG = { cluster: 'devnet', rpcUrl: RPC, programIds: { escrow: escrow.toBase58() } } as const;

const setup: EscrowSetup = {
  client: createSquareClient({
    connection: new Connection(RPC),
    commitment: 'confirmed',
    programIds: { registry: key(), policy: key(), verifier: key(), escrow },
  }),
  registryProgram: key(),
  policyProgram: key(),
  minChallengePeriod: 60n,
  maxChallengePeriod: 604_800n,
  travelRuleThreshold: 1_000_000_000n,
  keeperFeeBps: 50,
};

const openJob = (commitment = new Uint8Array(32)): TravelRuleJob => ({
  status: 'open',
  amount: 1_500_000_000n,
  mint: key(),
  agentWallet: key(),
  commitment,
});

function Section({ job, viewer }: { job: TravelRuleJob; viewer: PublicKey | null }) {
  const vault = useTravelRuleVault(viewer?.toBase58() ?? null);
  return (
    <JobTravelRule
      setup={setup}
      jobAddress={jobKey.toBase58()}
      job={job}
      institution={viewer}
      vault={vault}
      formatAmount={(base) => `${base} base units`}
    />
  );
}

const mount = (job: TravelRuleJob, viewer: PublicKey | null) =>
  render(
    <Providers config={CONFIG}>
      <main>
        <Section job={job} viewer={viewer} />
      </main>
    </Providers>,
  );

const axeViolations = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

beforeEach(() => {
  window.localStorage.clear();
  requests.length = 0;
});
afterEach(cleanup);

describe('Travel Rule section', () => {
  it('shows only the status to someone other than the institution', () => {
    // İş sayfası kurum olmayan cüzdana `institution` olarak null verir.
    mount(openJob(), null);
    expect(screen.getByText('Waiting for the commitment')).toBeTruthy();
    expect(screen.getByText(/cannot be funded until the institution binds the commitment/)).toBeTruthy();
    expect(screen.queryByLabelText('Legal name')).toBeNull();
    expect(screen.queryByRole('button', { name: /Bind/ })).toBeNull();
  });

  it('keeps the form in the browser, encrypts the store and binds nothing without it', { timeout: 20000 }, async () => {
    const { container } = mount(openJob(), institution);
    // Depo yokken bağlama kapalı: kayıt tx'ten önce şifreli depoya yazılır.
    const bind = () => screen.getByRole('button', { name: 'Bind the Travel Rule commitment' }) as HTMLButtonElement;
    expect(bind().disabled).toBe(true);

    const [originatorName] = screen.getAllByLabelText('Legal name');
    fireEvent.change(originatorName!, { target: { value: 'Grace Research GmbH' } });
    fireEvent.change(screen.getAllByLabelText('National identifier')[0]!, { target: { value: 'HRB 998877' } });
    fireEvent.change(await screen.findByLabelText('New passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.change(screen.getByLabelText('Repeat the passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.click(screen.getByRole('button', { name: 'Create the encrypted store' }));
    await screen.findByText('Unlocked: 0 records', undefined, { timeout: 10000 });

    // Ağ doğrulanmadı: depo açık olsa da tx kurulmaz.
    expect(bind().disabled).toBe(true);
    const stored = window.localStorage.getItem(`square-travel-rule:${institution.toBase58()}`)!;
    expect(JSON.parse(stored)).toMatchObject({ format: 'square-travel-rule-vault', owner: institution.toBase58() });
    expect(stored.includes('Grace Research')).toBe(false);
    // Formun içeriği hiçbir isteğe girmedi.
    expect(requests.some((request) => request.includes('Grace') || request.includes('HRB 998877'))).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('recomputes the bound commitment from the local record', { timeout: 20000 }, async () => {
    const job = openJob();
    const entry = createTravelRuleEntry({
      job: jobKey,
      record: {
        originator: { type: 'legal', name: 'A', account: institution.toBase58(), vasp: { name: 'Self-hosted' } },
        beneficiary: { type: 'legal', name: 'B', account: job.agentWallet.toBase58(), vasp: { name: 'V' } },
        amount: job.amount.toString(),
        asset: job.mint.toBase58(),
      },
      now: 1_790_000_000,
    });
    saveVault(await sealVault(await createVaultKey(institution.toBase58(), PASSPHRASE), [entry]));

    const { container } = mount({ ...job, commitment: hexToBytes(entry.commitment) }, institution);
    expect(screen.getByText('Commitment bound')).toBeTruthy();
    expect(screen.getByText(entry.commitment)).toBeTruthy();
    const verify = screen.getByRole('button', { name: 'Verify with the local record' }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);

    fireEvent.change(await screen.findByLabelText('Passphrase'), { target: { value: 'not the passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock the records' }));
    await screen.findByText('Wrong passphrase, or the file was changed.', undefined, { timeout: 10000 });

    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock the records' }));
    await screen.findByText('Unlocked: 1 record', undefined, { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Verify with the local record' }));
    await waitFor(() => expect(screen.getByText('Matches')).toBeTruthy());
    // Bağlı commitment fonlamaya kadar değiştirilebilir: form açık kalır.
    expect(screen.getByRole('button', { name: 'Bind a new commitment' })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('reports a commitment that no local record explains', { timeout: 20000 }, async () => {
    saveVault(await sealVault(await createVaultKey(institution.toBase58(), PASSPHRASE), []));
    mount({ ...openJob(new Uint8Array(32).fill(7)), status: 'funded' }, institution);
    fireEvent.change(await screen.findByLabelText('Passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock the records' }));
    await screen.findByText('Unlocked: 0 records', undefined, { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: 'Verify with the local record' }));
    await waitFor(() => expect(screen.getByText('No record')).toBeTruthy());
    // Fonlanmış işte commitment değişmez: form yok.
    expect(screen.queryByRole('button', { name: /Bind/ })).toBeNull();
  });
});
