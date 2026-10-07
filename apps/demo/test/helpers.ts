import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';

export const IDS = {
  registry: SQUARE_IDLS.registry.address,
  policy: SQUARE_IDLS.policy.address,
  verifier: SQUARE_IDLS.verifier.address,
  escrow: SQUARE_IDLS.escrow.address,
};
export const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const tempDir = (prefix = 'square-demo-test-') => mkdtempSync(join(tmpdir(), prefix));
export const address = () => Keypair.generate().publicKey.toBase58();

export const policy = (overrides: Record<string, unknown> = {}) => ({
  maxPerTx: '10000000',
  maxDaily: '100000000',
  dailyCeiling: '200000000',
  categories: ['research'],
  ...overrides,
});

export const scenario = (overrides: Record<string, unknown> = {}) => ({
  policy: 'standard',
  expect: 'approved',
  amount: '5000000',
  paymentCategory: 'research',
  challengePeriodSecs: 60,
  deadlineSecs: 3_600,
  report: { targets: ['institution', 'institution:usdc', 'mint'] },
  ...overrides,
});

export function rawDemoConfig(
  overrides: {
    seed?: Record<string, unknown>;
    agent?: Record<string, unknown>;
    demo?: Record<string, unknown>;
    root?: Record<string, unknown>;
  } = {},
) {
  return {
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    commitment: 'confirmed',
    programIds: IDS,
    settlementMint: USDC_DEVNET,
    lookupTable: '3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG',
    keys: {
      payer: 'keys/payer.json',
      screener: 'keys/screener.json',
      institution: 'keys/institution.json',
      agent: 'keys/agent.json',
      buyer: 'keys/buyer.json',
      keeper: 'keys/keeper.json',
    },
    seed: {
      institutionName: 'Square demo kurumu',
      policySecret: 'state/policy-secret',
      output: 'state/seed-devnet.json',
      policies: { standard: policy(), strict: policy({ maxPerTx: '1000000' }) },
      funding: {
        institutionUsdc: '20000000',
        buyerUsdc: '5000000',
        agentLamports: 100_000_000,
        keeperLamports: '50000000',
      },
      screening: { minRemainingSecs: 86_400 },
      ...overrides.seed,
    },
    demo: {
      agent: {
        agentId: 'square-demo-reporter',
        name: 'Square demo agent',
        description: 'Zincir raporu',
        version: '1.0.0',
        publicUrl: 'https://agent.example.org/',
        price: '1000000',
        autoListClaimBps: 300,
        ...overrides.agent,
      },
      scenarios: {
        approved: scenario(),
        refused: scenario({ policy: 'strict', expect: 'refused' }),
      },
      ...overrides.demo,
    },
    ...overrides.root,
  };
}
