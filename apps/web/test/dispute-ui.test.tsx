// @vitest-environment jsdom
// Uyuşmazlık arayüzü (FE-17): iş sayfasının dispute bölümü (oy durumu ve geri sayım, lapse edilebilir uyarı,
// kararın ödenişi ve ispat kapısı, lapse sonrası bilgi), arbitrator konsolunun kuyruk kartı (oylar, kanıtlar,
// sabitlenmiş karar, kapanmış oy) ve konsolun ön koşulları. Hesaplar escrow IDL'iyle kodlanıp sahte zincirden
// okunur; RPC yerelde dinlenmeyen bir adrestir, ağ doğrulanmaz, cüzdan bağlı değildir.
import './helpers/record-requests';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import BN from 'bn.js';
import type { PublicKey } from '@solana/web3.js';
import { createApiClient, createPda } from '@squaresdk/solana-sdk';
import type { ArbitrationQueueItem } from '@squaresdk/solana-types';
import { afterEach, describe, expect, it } from 'vitest';
import { ArbitrationPage } from '@/components/arbitration/arbitration-page';
import { QueueCard, QueuePager, queuePages } from '@/components/arbitration/arbitration-console';
import { JobDispute } from '@/components/jobs/job-dispute';
import { Providers } from '@/components/providers';
import type { ApiClientState } from '@/components/api-client';
import { disputeParamsOf } from '@/lib/dispute';
import type { EscrowSetup } from '@/lib/job-wizard';
import { configAccount, encodeConfig, fakeClient, FakeChain, jobAccount, key } from './helpers/escrow-accounts';

const RPC = 'http://127.0.0.1:9';
const escrow = key();
const CONFIG = { cluster: 'devnet', rpcUrl: RPC, programIds: { escrow: escrow.toBase58() } } as const;
const [institution, agent, mint] = [key(), key(), key()];
const arbitrators = [key(), key(), key()];
const jobKey = key();
const RAISED = 1_790_008_000;
const DEADLINE = RAISED + 259_200;
const usdc = (base: bigint) => `${Number(base) / 1_000_000} USDC`;

async function setupWith(): Promise<EscrowSetup> {
  const chain = new FakeChain();
  const pda = createPda({ registry: key(), policy: key(), verifier: key(), escrow });
  chain.put(pda.escrowConfig()[0], await encodeConfig({ arbitrators, threshold: 2 }), escrow);
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

const disputedJob = (
  status: string,
  dispute: Record<string, unknown> = {},
  policy: PublicKey | null = null,
  rejectionMask = 0,
) =>
  jobAccount({
    institution,
    agent_wallet: agent,
    mint,
    status,
    policy,
    dispute_rejection_mask: rejectionMask,
    dispute: { challenger: institution, bond: 12_500_000, raised_at: RAISED, deadline: DEADLINE, ...dispute },
  });

async function mountDispute(account: Awaited<ReturnType<typeof jobAccount>>, chainNow: number) {
  const setup = await setupWith();
  return render(
    <Providers config={CONFIG}>
      <main>
        <JobDispute
          escrow={setup}
          jobKey={jobKey}
          account={account}
          token={null}
          chainNow={chainNow}
          revision={0}
          formatAmount={usdc}
        />
      </main>
    </Providers>,
  );
}

const axeViolations = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

afterEach(cleanup);

describe('dispute section of the job page', () => {
  it('shows the votes against the threshold and the deadline countdown', { timeout: 20000 }, async () => {
    const account = await disputedJob('disputed', {
      approval_mask: 0b1,
      approval_count: 1,
      resolution: { FavorInstitution: {} },
    });
    const { container } = await mountDispute(account, DEADLINE - 3_660);
    expect(screen.getByText('Open for votes')).toBeTruthy();
    expect(await screen.findByText('1 of 2')).toBeTruthy();
    expect(screen.getByText('In favor of the institution')).toBeTruthy();
    expect(screen.getByText('1 h 1 min left (chain time)')).toBeTruthy();
    expect(screen.getByText('12.5 USDC')).toBeTruthy();
    expect(screen.getByText('the institution')).toBeTruthy();
    // Bağlı cüzdan yok: lapse ve ödeme düğmeleri yok, taraf değil: kanıt yok.
    expect(screen.queryByRole('button', { name: 'Lapse the dispute' })).toBeNull();
    expect(screen.queryByText('Evidence')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('warns that an undecided dispute past its deadline can be lapsed', { timeout: 20000 }, async () => {
    const { container } = await mountDispute(await disputedJob('disputed'), DEADLINE);
    expect(screen.getByText('Deadline passed')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Can be lapsed')).toBeTruthy();
    expect(alert.textContent).toMatch(/Anyone can lapse the dispute: the bond goes back to the institution/);
    expect((screen.getByRole('button', { name: 'Lapse the dispute' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Connect a wallet to send the transaction; anyone can.')).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('pays out a decision and says the agent side waits for a proof on a policy job', { timeout: 20000 }, async () => {
    const account = await disputedJob(
      'resolved',
      { decided_at: RAISED + 100, approval_count: 2, resolution: { Split: { agent_amount: new BN(100_000_000) } } },
      key(),
    );
    await mountDispute(account, RAISED + 200);
    expect(screen.getByText('Decided')).toBeTruthy();
    expect(screen.getByText('Split: 100 USDC to the agent, the rest back to the institution')).toBeTruthy();
    expect(screen.getByText('100 USDC')).toBeTruthy();
    expect(screen.getByText('150 USDC')).toBeTruthy();
    expect(screen.getByText('12.5 USDC returned to the institution')).toBeTruthy();
    expect(screen.getByText(/the payment waits \(ProofRequired\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Execute the resolution' })).toBeTruthy();
  });

  it('tells that the dispute lapsed and the bond was refunded once the job is back to Delivered', async () => {
    const account = await disputedJob('delivered', { lapsed: true, closed_at: DEADLINE + 30 });
    await mountDispute(account, DEADLINE + 60);
    expect(screen.getByText('Lapsed')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe(
      'The dispute lapsed without a decision: the bond of 12.5 USDC was refunded to the institution. The job went back to Delivered and settles through finalize_payment.',
    );
    expect(screen.queryByText('Votes')).toBeNull();
  });

  it('stays hidden when there is no dispute and nothing to do', async () => {
    const account = await jobAccount({ institution, agent_wallet: agent, mint });
    const { container } = await mountDispute(account, RAISED);
    expect(container.querySelector('section')).toBeNull();
  });
});

describe('arbitration console', () => {
  const meta = { requestId: 'r', page: null, limit: null, total: null };
  const session = (): ApiClientState => ({
    configured: true,
    publicApi: null,
    api: createApiClient({
      baseUrl: 'https://api.square.example',
      fetch: async () => Response.json({ success: true, data: [], error: null, meta }),
    }),
    session: { token: 'sqs_x', wallet: arbitrators[0]!.toBase58(), expiresAt: 1_790_100_000 },
    canSignIn: true,
    unavailable: null,
    signingIn: false,
    error: null,
    signIn: async () => undefined,
    signOut: async () => undefined,
    report: (error) => String(error),
  });

  async function mountCard(dispute: Record<string, unknown>, chainNow: number, hasVoted = false, rejectionMask = 0) {
    const setup = await setupWith();
    const params = disputeParamsOf(await configAccount({ arbitrators, threshold: 2 }));
    const account = await disputedJob('disputed', dispute, null, rejectionMask);
    const item: ArbitrationQueueItem = {
      dispute: {
        job: jobKey.toBase58(),
        jobStatus: 'disputed',
        institution: institution.toBase58(),
        agentRecord: key().toBase58(),
        dispute: {
          challenger: institution.toBase58(),
          bond: '12500000',
          reasonHash: 'ab'.repeat(32),
          raisedAt: RAISED,
          deadline: DEADLINE,
          decidedAt: 0,
          closedAt: 0,
          lapsed: false,
          approvalMask: 2,
          approvalCount: 1,
          arbitratorSetVersion: 0,
          resolution: { kind: 'favorAgent' },
        },
        slot: 10,
        indexedAt: RAISED,
      },
      votes: [
        {
          kind: 'approve',
          arbitrator: arbitrators[1]!.toBase58(),
          resolution: { kind: 'favorAgent' },
          approvalCount: 1,
          rejectionCount: null,
          proposalReset: false,
          signature: '5'.repeat(88),
          slot: 9,
          blockTime: RAISED + 60,
        },
        {
          kind: 'reject',
          arbitrator: arbitrators[2]!.toBase58(),
          resolution: { kind: 'favorInstitution' },
          approvalCount: null,
          rejectionCount: 1,
          proposalReset: false,
          signature: '6'.repeat(88),
          slot: 10,
          blockTime: RAISED + 120,
        },
      ],
      hasVoted,
      canVote: !hasVoted,
      threshold: 2,
      evidence: [
        {
          id: 'e1',
          job: jobKey.toBase58(),
          reasonHash: 'ab'.repeat(32),
          contentType: 'application/pdf',
          size: 2048,
          role: 'institution',
          uploadedBy: institution.toBase58(),
          isDisputeReason: true,
          createdAt: RAISED - 10,
        },
      ],
    };
    return render(
      <Providers config={CONFIG}>
        <main>
          <QueueCard
            entry={{ item, job: jobKey, account }}
            escrow={setup}
            escrowKey={escrow}
            params={params}
            arbitrator={arbitrators[0]!}
            chainNow={chainNow}
            session={session()}
            decimals={6}
            formatAmount={usdc}
            onConfirmed={() => undefined}
          />
        </main>
      </Providers>,
    );
  }

  it(
    'shows the votes and evidence; a different decision rejects the pending proposal',
    { timeout: 20000 },
    async () => {
      const { container } = await mountCard(
        { approval_mask: 0b010, approval_count: 1, resolution: { FavorAgent: {} } },
        DEADLINE - 7_200,
        false,
        0b100,
      );
      expect(screen.getByText('2 h left')).toBeTruthy();
      expect(screen.getByText('1 of 2')).toBeTruthy();
      const votes = screen.getByRole('list', { name: 'Votes' }).textContent;
      expect(votes).toContain('In favor of the agent');
      expect(votes).toContain('Rejected for In favor of the institution');
      const evidence = screen.getByRole('list', { name: 'Dispute evidence' });
      expect(within(evidence).getByText('Dispute reason')).toBeTruthy();
      expect(within(evidence).getByRole('button', { name: 'Download' })).toBeTruthy();
      expect(screen.getByText(/Pending proposal: In favor of the agent\. Voting for it approves it/)).toBeTruthy();
      const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;
      expect(
        [radio('In favor of the agent'), radio('In favor of the institution'), radio('Split')].map((r) => r.disabled),
      ).toEqual([false, false, false]);
      fireEvent.click(radio('In favor of the agent'));
      expect(screen.getByRole('button', { name: 'Approve the proposal' })).toBeTruthy();
      fireEvent.click(radio('In favor of the institution'));
      // Ağ doğrulanmadı: oy düğmesi kapalı, tx kurulmaz.
      expect((screen.getByRole('button', { name: 'Reject the proposal' }) as HTMLButtonElement).disabled).toBe(true);
      expect(await axeViolations(container)).toEqual([]);
    },
  );

  it('closes the vote at the deadline and after voting', { timeout: 20000 }, async () => {
    await mountCard({}, DEADLINE);
    expect(screen.getByText('Deadline passed')).toBeTruthy();
    expect(screen.getByText('Voting closed: the dispute deadline has passed.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Split' }).matches(':disabled')).toBe(true);
    cleanup();
    await mountCard({ approval_mask: 0b001, approval_count: 1, resolution: { FavorAgent: {} } }, RAISED + 100);
    expect(screen.getByText('You have already voted on the pending proposal.')).toBeTruthy();
  });

  it('pages through a queue longer than one page', async () => {
    expect([queuePages(0), queuePages(50), queuePages(51), queuePages(120)]).toEqual([1, 1, 2, 3]);
    const { container } = render(<QueuePager page={1} pages={1} onPage={() => undefined} />);
    expect(container.innerHTML).toBe('');
    cleanup();
    const asked: number[] = [];
    const { container: pager } = render(
      <main>
        <QueuePager page={2} pages={3} onPage={(next) => asked.push(next)} />
      </main>,
    );
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(asked).toEqual([3, 1]);
    expect(await axeViolations(pager)).toEqual([]);
    cleanup();
    render(<QueuePager page={3} pages={3} onPage={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Next' }).matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous' }).matches(':disabled')).toBe(false);
  });

  it('needs the Square API and an arbitrator wallet', () => {
    render(
      <Providers config={CONFIG}>
        <ArbitrationPage />
      </Providers>,
    );
    expect(screen.getByText(/The arbitration console needs the Square API/)).toBeTruthy();
    cleanup();
    render(
      <Providers config={{ ...CONFIG, apiUrl: 'https://api.square.example' }}>
        <ArbitrationPage />
      </Providers>,
    );
    expect(screen.getByText('Connect an arbitrator wallet to open the console.')).toBeTruthy();
  });
});
