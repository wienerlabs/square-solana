import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { SIGNAL, buildSetComplianceProofTx } from '../../dist/index.js';

const key = (seed) => new PublicKey(new Uint8Array(32).fill(seed));
const hex32 = (value) => value.toString(16).padStart(64, '0');
const connection = {
  commitment: 'confirmed',
  getLatestBlockhash: async () => ({ blockhash: key(9).toBase58(), lastValidBlockHeight: 1 }),
};
const client = createSquareClient({
  connection,
  programIds: { registry: key(1), policy: key(2), verifier: key(3), escrow: key(4) },
});

const netAmount = 2n ** 64n - 1n;
const timestamp = 2n ** 63n - 1n;
const publicInputs = Array.from({ length: 13 }, () => hex32(0n));
publicInputs[SIGNAL.netAmount] = hex32(netAmount);
publicInputs[SIGNAL.timestamp] = hex32(timestamp);
const proof = {
  artifactVersion: hex32(0n),
  proofA: '01'.repeat(64),
  proofB: '02'.repeat(128),
  proofC: '03'.repeat(64),
  publicInputs,
  provingMs: 0,
};

const { transaction } = await buildSetComplianceProofTx(
  client,
  { authority: key(5), institution: key(6), policy: key(7), job: key(8), proof },
  { feePayer: key(5) },
);
const [ix] = transaction.message.compiledInstructions;
const decoded = client.verifier.program.coder.instruction.decode(Buffer.from(ix.data));
assert.ok(decoded);
assert.equal(decoded.name, 'setComplianceProof');
assert.equal(decoded.data.netAmount.toString(), netAmount.toString());
assert.equal(decoded.data.proofTimestamp.toString(), timestamp.toString());
