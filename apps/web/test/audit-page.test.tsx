// @vitest-environment jsdom
// Denetim sayfası (FE-12): geçersiz adres, escrow yapılandırılmadan kapalı olması, ağ doğrulanmadan job'un ve
// event'lerin okunmaması, erişilebilirlik. RPC ve API yerelde dinlenmeyen adreslerdir; sahte zincir verisi
// kullanılmaz.
import { requests } from './helpers/record-requests';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AuditRoute from '@/app/audit/[job]/page';
import { Providers } from '@/components/providers';

const RPC = 'http://127.0.0.1:9';
const API = 'http://127.0.0.1:10';
const escrow = Keypair.generate().publicKey.toBase58();
const job = Keypair.generate().publicKey.toBase58();

beforeEach(() => {
  requests.length = 0;
});
afterEach(cleanup);

const route = (address: string) => AuditRoute({ params: Promise.resolve({ job: address }) });

describe('/audit/[job]', () => {
  it('refuses an address that is not a job', async () => {
    render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: { escrow } }}>{await route('nope')}</Providers>,
    );
    expect(screen.getByText('This is not a job address.')).toBeTruthy();
  });

  it('is unavailable without the escrow program', async () => {
    render(<Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: {} }}>{await route(job)}</Providers>);
    expect(screen.getByText('SQUARE_PROGRAM_ID_ESCROW')).toBeTruthy();
  });

  it('reads neither the job nor its events until the network is verified', { timeout: 20000 }, async () => {
    const { container } = render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: { escrow }, apiUrl: API }}>
        {await route(job)}
      </Providers>,
    );
    await screen.findByText('The network is not verified, so the job is not read.', undefined, { timeout: 8000 });
    // Ağa giden tek istek genesis sorgusu: job, ispat ve API'nin event'leri okunmadı.
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
