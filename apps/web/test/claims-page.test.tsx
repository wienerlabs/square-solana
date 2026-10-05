// @vitest-environment jsdom
// Alacak piyasası sayfası (FE-08): escrow yapılandırılmadan sayfanın kapalı olması, ağ doğrulanmadan
// listelemelerin okunmaması, erişilebilirlik. RPC yerelde dinlenmeyen bir adrestir; sahte zincir verisi
// kullanılmaz.
import { requests } from './helpers/record-requests';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ClaimsRoute from '@/app/app/claims/page';
import { Providers } from '@/components/providers';

const RPC = 'http://127.0.0.1:9';
const escrow = Keypair.generate().publicKey.toBase58();

beforeEach(() => {
  requests.length = 0;
});
afterEach(cleanup);

describe('/app/claims', () => {
  it('is unavailable without the escrow program', () => {
    render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: {} }}>
        <ClaimsRoute />
      </Providers>,
    );
    expect(screen.getByText('SQUARE_PROGRAM_ID_ESCROW')).toBeTruthy();
  });

  it('reads no listing until the network is verified', { timeout: 20000 }, async () => {
    const { container } = render(
      <Providers config={{ cluster: 'devnet', rpcUrl: RPC, programIds: { escrow } }}>
        <ClaimsRoute />
      </Providers>,
    );
    await screen.findByText('The network is not verified, so the listings are not read.', undefined, {
      timeout: 8000,
    });
    // Listelemeler (getProgramAccounts) ve escrow config'i okunmadı: tek istek genesis sorgusu.
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
