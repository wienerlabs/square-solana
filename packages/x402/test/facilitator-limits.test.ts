import {
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  signBytes,
  type KeyPairSigner,
} from '@solana/kit';
import type { PaymentPayload } from '@x402/core/types';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { describe, expect, it, vi } from 'vitest';
import { createSelfFacilitator, localFacilitatorClient } from '../src/facilitator.js';
import { SOLANA_DEVNET } from '../src/networks.js';
import {
  buildPaymentHeader,
  createWallets,
  memoryReplayStore,
  startFakeSolanaRpc,
  startPaidApp,
  TEST_LIMITS,
} from './helpers.js';

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
  it('sınırlar zorunludur ve şemaya olduğu gibi geçer', async () => {
    const wallets = await createWallets();
    const rpcUrls = { [SOLANA_DEVNET]: 'http://127.0.0.1:9' };
    createSelfFacilitator({ feePayer: wallets.feePayer, rpcUrls, limits: TEST_LIMITS });
    expect(constructed.at(-1)![2]).toEqual({ ...TEST_LIMITS });
    expect(() => createSelfFacilitator({ feePayer: wallets.feePayer, rpcUrls } as never)).toThrow(/limits gerekli/);
    for (const bad of [undefined, 0, 1.5, Number.NaN]) {
      expect(() =>
        createSelfFacilitator({
          feePayer: wallets.feePayer,
          rpcUrls,
          limits: { ...TEST_LIMITS, maxComputeUnits: bad as number },
        }),
      ).toThrow(/limits\.maxComputeUnits/);
    }
  });
});

async function withComputeBudget(
  payload: PaymentPayload,
  payer: KeyPairSigner,
  units: number,
  microLamports: bigint,
): Promise<PaymentPayload> {
  const wire = getBase64Encoder().encode((payload.payload as { transaction: string }).transaction);
  const transaction = getTransactionDecoder().decode(wire);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, units, true);
  const price = new Uint8Array(9);
  price[0] = 3;
  new DataView(price.buffer).setBigUint64(1, microLamports, true);
  const [limitIx, priceIx, ...rest] = message.instructions;
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...message,
    instructions: [{ ...limitIx!, data: limit }, { ...priceIx!, data: price }, ...rest],
  });
  const signature = await signBytes(payer.keyPair.privateKey, messageBytes);
  const patched = getTransactionEncoder().encode({
    messageBytes: messageBytes as typeof transaction.messageBytes,
    signatures: { ...transaction.signatures, [payer.address]: signature },
  });
  return { ...payload, payload: { ...payload.payload, transaction: getBase64Decoder().decode(patched) } };
}

describe('kendi facilitator’ın ücret sınırları doğrulamada', () => {
  it('sınırı aşan compute ya da priority fee facilitator imzalamadan reddedilir', async () => {
    const rpc = await startFakeSolanaRpc();
    const wallets = await createWallets();
    rpc.addMint(wallets.mint, 6);
    const app = await startPaidApp(wallets, rpc, { replay: memoryReplayStore() });
    try {
      const headers = await buildPaymentHeader(`${app.url}/report`, wallets, rpc);
      const payload = decodePaymentSignatureHeader(headers['PAYMENT-SIGNATURE']!);
      const requirements = payload.accepted;
      const rpcUrls = { [SOLANA_DEVNET]: rpc.url };
      const strict = localFacilitatorClient(
        createSelfFacilitator({ feePayer: wallets.feePayer, rpcUrls, limits: TEST_LIMITS }),
      );
      const manyUnits = await withComputeBudget(payload, wallets.payer, 1_400_000, 1n);
      const highPrice = await withComputeBudget(payload, wallets.payer, 20_000, 1_000_000n);

      expect(await strict.verify(payload, requirements)).toMatchObject({ isValid: true });
      expect(await strict.verify(manyUnits, requirements)).toMatchObject({
        isValid: false,
        invalidReason: expect.stringContaining('compute_limit'),
      });
      expect(await strict.verify(highPrice, requirements)).toMatchObject({
        isValid: false,
        invalidReason: expect.stringContaining('compute_price'),
      });
    } finally {
      await app.close();
      await rpc.close();
    }
  });
});
