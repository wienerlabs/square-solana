// @vitest-environment jsdom
// İş açma sayfası (FE-06): giriş koşulu, ağ doğrulanmadan escrow'un okunmaması ve tx açılmaması,
// erişilebilirlik. RPC yerelde dinlenmeyen bir adrestir; sahte zincir verisi kullanılmaz.
import { requests } from './helpers/record-requests';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import NewJobRoute from '@/app/app/jobs/new/page';
import { JobWizard } from '@/components/jobs/job-wizard';
import { Providers } from '@/components/providers';

const RPC = 'http://127.0.0.1:9';
const escrow = Keypair.generate().publicKey.toBase58();
const owner = Keypair.generate().publicKey.toBase58();
const CONFIG = { cluster: 'devnet', rpcUrl: RPC, programIds: { escrow } } as const;

beforeEach(() => {
  window.localStorage.clear();
  requests.length = 0;
});
afterEach(cleanup);

describe('/app/jobs/new', () => {
  it('asks for the institution wallet first', () => {
    render(
      <Providers config={CONFIG}>
        <NewJobRoute />
      </Providers>,
    );
    expect(screen.getByText(/Connect the institution's wallet to open a job/)).toBeTruthy();
  });

  it('reads no escrow and opens no job until the network is verified', { timeout: 20000 }, async () => {
    const { container } = render(
      <Providers config={CONFIG}>
        <main>
          <JobWizard owner={owner} escrowProgramId={escrow} />
        </main>
      </Providers>,
    );
    await screen.findByText(/The network is not verified, so the escrow is not read/, undefined, { timeout: 8000 });
    expect(screen.queryByRole('button', { name: 'Create the job' })).toBeNull();
    // Escrow config'i ve settlement mint'i okunmadı: ağa giden tek istek genesis sorgusu.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.includes('getGenesisHash'))).toBe(true);
    const violations = (
      await axe.run(container, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        rules: { 'color-contrast': { enabled: false } },
      })
    ).violations.map((v) => `${v.id}: ${v.help}`);
    expect(violations).toEqual([]);
  });
});
