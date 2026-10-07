// @vitest-environment jsdom
// Kabul öncesi ön-ispat bölümü (P-01, ADR 0028): policy'li işte kabulden önce görünür; ön-ispat yoksa ya da
// bağlıysa durumu söyler, kabulden sonra ve policy'siz işte yoktur; erişilebilirlik. Hesaplar escrow IDL'iyle
// kodlanır; RPC yerelde dinlenmeyen bir adrestir, cüzdan bağlı değildir. Gerçek ispatla yol programların
// testlerindedir (tests/programs/tests/preflight.rs).
import './helpers/record-requests';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { createPda } from '@squaresdk/solana-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { JobPreflight } from '@/components/jobs/job-preflight';
import { Providers } from '@/components/providers';
import type { EscrowSetup } from '@/lib/job-wizard';
import type { PreflightView, ReleaseState } from '@/lib/release-proof';
import { encodeConfig, fakeClient, FakeChain, jobAccount, key } from './helpers/escrow-accounts';

const RPC = 'http://127.0.0.1:9';
const escrow = key();
const CONFIG = { cluster: 'devnet', rpcUrl: RPC, programIds: { escrow: escrow.toBase58() } } as const;
const [institution, agent, mint] = [key(), key(), key()];
const NOW = 1_790_000_000;

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

const release: { state: 'ready'; value: ReleaseState } = {
  state: 'ready',
  value: { proof: null, operator: null, keeperFeeBps: 50, institution: key(), multisigVault: null },
};

async function mount(status: string, preflight: PreflightView | null, policy = key() as ReturnType<typeof key> | null) {
  const setup = await setupWith();
  const account = await jobAccount({ institution, agent_wallet: agent, mint, status, policy });
  return render(
    <Providers config={CONFIG}>
      <main>
        <JobPreflight
          escrow={setup}
          jobKey={key()}
          account={account}
          preflight={{ state: 'ready', value: preflight }}
          release={release}
          chainNow={NOW}
        />
      </main>
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

afterEach(cleanup);

describe('pre-acceptance proof section', () => {
  it('waits for the institution before the agent can accept', { timeout: 20000 }, async () => {
    const { container } = await mount('funded', null);
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('Waiting for the institution to bind it.')).toBeTruthy();
    expect(await a11y(container)).toEqual([]);
  });

  it('tells when it is bound and which temporary rules may still hold the release', async () => {
    await mount('open', { refusalCode: 0, proofTimestamp: NOW - 60 });
    expect(screen.getByText('Bound')).toBeTruthy();
    expect(screen.getByText(/the job satisfies the policy/)).toBeTruthy();
    cleanup();
    await mount('funded', { refusalCode: 32, proofTimestamp: NOW - 60 });
    expect(
      screen.getByText(/temporary rules may still hold the release: The release is outside the allowed time window/),
    ).toBeTruthy();
  });

  it('is gone once the job is accepted, and on a job without a policy', async () => {
    const { container } = await mount('accepted', { refusalCode: 0, proofTimestamp: NOW - 60 });
    expect(container.querySelector('section')).toBeNull();
    cleanup();
    const plain = await mount('funded', null, null);
    expect(plain.container.querySelector('section')).toBeNull();
  });
});
