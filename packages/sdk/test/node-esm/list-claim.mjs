import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { createSquareClient } from '../../dist/index.js';

const key = (seed) => new PublicKey(new Uint8Array(32).fill(seed));
const connection = {
  commitment: 'confirmed',
  getLatestBlockhash: async () => ({ blockhash: key(9).toBase58(), lastValidBlockHeight: 1 }),
};
const client = createSquareClient({
  connection,
  programIds: { registry: key(1), policy: key(2), verifier: key(3), escrow: key(4) },
});

const price = 2n ** 64n - 1n;
const { transaction } = await client.flow.listClaim({ agent: key(5), job: key(6), price }, { feePayer: key(5) });
const keys = transaction.message.staticAccountKeys;
const ix = transaction.message.compiledInstructions.find((i) => keys[i.programIdIndex].equals(key(4)));
const decoded = client.escrow.program.coder.instruction.decode(Buffer.from(ix.data));
assert.ok(decoded);
assert.equal(decoded.name, 'listClaim');
assert.equal(decoded.data.price.toString(), price.toString());
