// Test yardımcıları: geçici dizinde üretilen anahtar dosyaları ve geçerli bir küme yapılandırması.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';

/** Program kimlikleri: SDK'nın IDL'lerindeki adresler (BC-09'da `set-program-ids.mjs` günceller). */
export const IDS = {
  registry: SQUARE_IDLS.registry.address,
  policy: SQUARE_IDLS.policy.address,
  verifier: SQUARE_IDLS.verifier.address,
  escrow: SQUARE_IDLS.escrow.address,
};
export const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export function tempDir(prefix = 'square-smoke-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Anahtarı çalışma anında üretip dosyaya yazar (depoya anahtar girmez). */
export function writeKey(dir: string, name: string): Keypair {
  const keypair = Keypair.generate();
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

const key = () => Keypair.generate().publicKey.toBase58();

export function rawConfig(overrides: Record<string, unknown> = {}) {
  return {
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    commitment: 'confirmed',
    programIds: IDS,
    settlementMint: USDC_DEVNET,
    keys: { payer: 'keys/payer.json', screener: 'keys/screener.json' },
    init: {
      registry: { screenerAuthority: key(), screeningTtlSecs: 86_400 },
      verifier: { mppAuthority: key() },
      escrow: {
        arbitrators: [key(), key(), key()],
        threshold: 2,
        params: {
          minChallengePeriod: 60,
          maxChallengePeriod: '2592000',
          minBondBps: 500,
          minBondAbsolute: '1000000',
          keeperFeeBps: 50,
          proofTimeoutSecs: 86_400,
          disputeTimeoutSecs: 604_800,
          travelRuleThreshold: '3000000000',
        },
      },
    },
    smoke: {
      jobAmount: '1000000',
      claimPrice: 900_000,
      challengePeriodSecs: 60,
      deadlineSecs: 3_600,
      paymentCategory: 'research',
    },
    ...overrides,
  };
}
