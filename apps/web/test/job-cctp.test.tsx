// @vitest-environment jsdom
// CCTP ile fonlama paneli (FE-19): EVM cüzdanı olmayan tarayıcıda, ulaşılamayan API ve attestation servisiyle.
// Panel hiçbir şeyi varsaymaz: burn açılmaz, sebepler yazılır. RPC, API ve Circle'ın servisi yerelde dinlenmeyen
// bir adrestir; sahte veri kullanılmaz. Kurum, job ve mint devnet'teki BE-26 koşusununkilerdir.
import { requests } from './helpers/record-requests';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CctpFunding } from '@/components/jobs/job-cctp';
import { Providers } from '@/components/providers';
import type { CctpSource } from '@/lib/config';
import devnet from './fixtures/cctp-devnet.json';
import sepolia from './fixtures/cctp-sepolia.json';

const UNREACHABLE = 'http://127.0.0.1:9';
const SOURCE: CctpSource = {
  chain: { id: sepolia.chainId, name: 'Sepolia', explorerUrl: 'https://sepolia.etherscan.io' },
  domain: 0,
  tokenMessenger: sepolia.tokenMessenger as `0x${string}`,
  usdc: sepolia.usdc as `0x${string}`,
  attestationUrl: UNREACHABLE,
  messageTransmitter: devnet.messageTransmitter,
};
const CONFIG = {
  cluster: 'devnet',
  rpcUrl: UNREACHABLE,
  apiUrl: UNREACHABLE,
  programIds: { escrow: devnet.escrowProgram },
  cctp: SOURCE,
} as const;
const TOKEN = {
  mint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  tokenProgram: TOKEN_PROGRAM_ID,
  decimals: 6,
};

beforeEach(() => {
  window.localStorage.clear();
  requests.length = 0;
});
afterEach(cleanup);

describe('CCTP funding panel', () => {
  it('opens no burn without an EVM wallet, the fees or the transfers, and says why', { timeout: 20000 }, async () => {
    const { container } = render(
      <Providers config={CONFIG}>
        <main>
          <CctpFunding
            source={SOURCE}
            apiUrl={UNREACHABLE}
            owner={new PublicKey(devnet.institution)}
            job={devnet.receiveAndFund.job}
            jobAmount={999_900n}
            jobStatus="open"
            token={TOKEN}
            balance={null}
            escrowProgramId={devnet.escrowProgram}
            blocked={null}
            onFunded={() => undefined}
          />
        </main>
      </Providers>,
    );
    expect(screen.getByRole('heading', { name: 'Fund from Sepolia with CCTP' })).toBeTruthy();
    expect(screen.getByText(/No EVM wallet announced itself in this browser \(EIP-6963\)/)).toBeTruthy();
    await screen.findByText(/The transfers could not be read:/, undefined, { timeout: 8000 });
    await screen.findByText(/Circle's fees could not be read:/, undefined, { timeout: 8000 });
    // Kurumun Solana'da USDC hesabı yok: job'un tamamı eksik.
    expect(screen.getByText('0.9999 USDC')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Burn on Sepolia' }) as HTMLButtonElement).disabled).toBe(true);
    // Okunanlar: job'un transferleri (API) ve Circle'ın ücret tablosu; başka bir şey değil.
    expect(requests.some((r) => r.startsWith(`${UNREACHABLE}/v1/cctp/transfers?`))).toBe(true);
    expect(requests.some((r) => r.startsWith(`${UNREACHABLE}/v2/burn/USDC/fees/0/5`))).toBe(true);

    const violations = (
      await axe.run(container, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        rules: { 'color-contrast': { enabled: false } },
      })
    ).violations.map((v) => `${v.id}: ${v.help}`);
    expect(violations).toEqual([]);
  });

  it('stays out of the way of a job that is not open and has no transfer', { timeout: 20000 }, async () => {
    render(
      <Providers config={CONFIG}>
        <CctpFunding
          source={SOURCE}
          apiUrl={UNREACHABLE}
          owner={new PublicKey(devnet.institution)}
          job={devnet.receiveAndFund.job}
          jobAmount={999_900n}
          jobStatus="funded"
          token={TOKEN}
          balance={null}
          escrowProgramId={devnet.escrowProgram}
          blocked={null}
          onFunded={() => undefined}
        />
      </Providers>,
    );
    // API'ye ulaşılamadı: transferler bilinmiyor, panel sebebi söyler ama burn göstermez.
    await screen.findByText(/The transfers could not be read:/, undefined, { timeout: 8000 });
    expect(screen.queryByRole('button', { name: 'Burn on Sepolia' })).toBeNull();
  });
});
