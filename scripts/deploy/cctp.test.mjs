import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  FINALITY,
  SOLANA_DOMAIN,
  burnArguments,
  bytes32,
  fetchAttestation,
  maxFeeFor,
  mintRecipientFor,
} from './cctp.mjs';

const fees = [
  { finalityThreshold: 1000, minimumFee: 1 },
  { finalityThreshold: 2000, minimumFee: 0 },
];
const recipient = Keypair.generate().publicKey;
const usdc = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

test('mint alıcısı sahibin associated token hesabıdır', () => {
  // spl-token'ın getAssociatedTokenAddressSync'iyle aynı türetme; bilinen bir sahip ve mint.
  const owner = new PublicKey('7xNWRmEbp5aQFQuL1vAnJAW3iZn6NXA3CisMSAmnXoi4');
  const mint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  const expected = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), mint.toBuffer()],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  )[0];
  assert.ok(mintRecipientFor(owner, mint).equals(expected));
});

test('standart kesinlik: ücret sıfır, hedef Solana, çağıran serbest', () => {
  const args = burnArguments({ amount: 5_000_000n, finality: 'standard', recipient, burnToken: usdc, fees });
  assert.deepEqual(args, {
    amount: 5_000_000n,
    destinationDomain: SOLANA_DOMAIN,
    mintRecipient: bytes32(recipient.toBytes()),
    burnToken: usdc,
    destinationCaller: `0x${'00'.repeat(32)}`,
    maxFee: 0n,
    minFinalityThreshold: FINALITY.standard,
  });
});

test('hızlı kesinlik: baz puan yukarı yuvarlanır; ücret tutarı yutarsa ya da kesinlik bilinmiyorsa red', () => {
  assert.equal(maxFeeFor(5_000_000n, 1), 500n);
  assert.equal(maxFeeFor(1n, 1), 1n);
  assert.equal(burnArguments({ amount: 5_000_000n, finality: 'fast', recipient, burnToken: usdc, fees }).maxFee, 500n);
  assert.throws(
    () => burnArguments({ amount: 1n, finality: 'fast', recipient, burnToken: usdc, fees }),
    /karşılamıyor/,
  );
  assert.throws(() => burnArguments({ amount: 0n, finality: 'standard', recipient, burnToken: usdc, fees }), /pozitif/);
  assert.throws(() => burnArguments({ amount: 5n, finality: 'slow', recipient, burnToken: usdc, fees }), /kesinlik/);
  assert.throws(
    () => burnArguments({ amount: 5n, finality: 'fast', recipient, burnToken: usdc, fees: [] }),
    /ücret vermedi/,
  );
});

test('attestation: 404 ve bekleyen null, tamamlanan mesaj döner, hata fırlatır', async () => {
  const respond = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const query = { api: 'https://iris.example', sourceDomain: 0, transactionHash: '0xabc' };
  assert.equal(await fetchAttestation({ ...query, fetch: respond(404, {}) }), null);
  assert.equal(
    await fetchAttestation({ ...query, fetch: respond(200, { messages: [{ status: 'pending_confirmations' }] }) }),
    null,
  );
  assert.deepEqual(
    await fetchAttestation({
      ...query,
      fetch: respond(200, {
        messages: [{ status: 'complete', message: '0x01', attestation: '0x02', eventNonce: '0x03' }],
      }),
    }),
    { message: '0x01', attestation: '0x02', eventNonce: '0x03' },
  );
  await assert.rejects(fetchAttestation({ ...query, fetch: respond(500, {}) }), /500/);
});
