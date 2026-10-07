import { describe, expect, it, vi } from 'vitest';
import { createSelfFacilitator, SELF_FACILITATOR_LIMITS } from '../src/facilitator.js';
import { SOLANA_DEVNET } from '../src/networks.js';
import { createWallets } from './helpers.js';

const { constructed } = vi.hoisted(() => ({ constructed: [] as unknown[][] }));

vi.mock('@x402/svm/exact/facilitator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@x402/svm/exact/facilitator')>();
  class RecordedScheme extends actual.ExactSvmScheme {
    constructor(...args: ConstructorParameters<typeof actual.ExactSvmScheme>) {
      super(...args);
      constructed.push(args);
    }
  }
  return { ...actual, ExactSvmScheme: RecordedScheme };
});

describe('kendi facilitator’ın ücret sınırları', () => {
  it('compute, priority fee ve imza sayısı varsayılan olarak sınırlıdır; çağıranın ayarı ezer', async () => {
    const wallets = await createWallets();
    const rpcUrls = { [SOLANA_DEVNET]: 'http://127.0.0.1:9' };
    createSelfFacilitator({ feePayer: wallets.feePayer, rpcUrls });
    createSelfFacilitator({ feePayer: wallets.feePayer, rpcUrls, scheme: { maxComputeUnits: 300_000 } });
    expect(constructed.map((args) => args[2])).toEqual([
      SELF_FACILITATOR_LIMITS,
      { ...SELF_FACILITATOR_LIMITS, maxComputeUnits: 300_000 },
    ]);
    expect(SELF_FACILITATOR_LIMITS).toEqual({
      maxComputeUnits: 100_000,
      maxPriorityFeeMicroLamports: 50_000,
      maxRequiredSignatures: 2,
    });
  });
});
