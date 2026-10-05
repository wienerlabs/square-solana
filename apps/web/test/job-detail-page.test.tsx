// @vitest-environment jsdom
// İş detayı sayfası (FE-07): geçersiz adres, ağ doğrulanmadan job'un okunmaması, erişilebilirlik. RPC
// yerelde dinlenmeyen bir adrestir; sahte zincir verisi kullanılmaz.
import { requests } from './helpers/record-requests';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JobRoute from '@/app/app/jobs/[job]/page';
import { JobDetail } from '@/components/jobs/job-detail';
import { Providers } from '@/components/providers';

const RPC = 'http://127.0.0.1:9';
const escrow = Keypair.generate().publicKey.toBase58();
const job = Keypair.generate().publicKey.toBase58();
const CONFIG = { cluster: 'devnet', rpcUrl: RPC, programIds: { escrow } } as const;

beforeEach(() => {
  requests.length = 0;
});
afterEach(cleanup);

describe('/app/jobs/[job]', () => {
  it('rejects something that is not an address', async () => {
    render(<Providers config={CONFIG}>{await JobRoute({ params: Promise.resolve({ job: 'not-a-job' }) })}</Providers>);
    expect(screen.getByText('This is not a job address.')).toBeTruthy();
  });

  it('reads no job until the network is verified', { timeout: 20000 }, async () => {
    const { container } = render(
      <Providers config={CONFIG}>
        <main>
          <JobDetail jobAddress={job} escrowProgramId={escrow} />
        </main>
      </Providers>,
    );
    await screen.findByText('The network is not verified, so the job is not read.', undefined, { timeout: 8000 });
    // Job, zaman çizelgesi ve zincir saati okunmadı; log aboneliği açılmadı: tek istek genesis sorgusu.
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
