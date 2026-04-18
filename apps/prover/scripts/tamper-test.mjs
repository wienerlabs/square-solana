#!/usr/bin/env node
// Proves the Groth16 pipeline is cryptographically binding: generate a valid
// proof, flip a single byte anywhere in it, and watch snarkjs reject the
// tampered version while accepting the original. A fast-but-fake proving
// system cannot do this.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.PROVER_BASE_URL ?? 'http://localhost:3003';
const VK_PATH = path.resolve(
  __dirname,
  '..',
  'artifacts',
  'payment_vk.json',
);

const COMPLIANT_INPUT = {
  max_daily_spend_lamports: 100000000,
  max_per_transaction_lamports: 10000000,
  allowed_endpoint_categories: ['compute', 'storage'],
  blocked_addresses: ['4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'],
  token_whitelist: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  payment_amount_lamports: 5000000,
  payment_token_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payment_recipient: 'CBDjvUkZZ6ucrVGrU3vRraasTytha8oVg2NLCxAHE25b',
  payment_endpoint_category: 'compute',
  daily_spent_so_far_lamports: 50000000,
};

function stringBigIntAdd(a, b) {
  return (BigInt(a) + BigInt(b)).toString();
}

async function callProve() {
  const res = await fetch(`${BASE_URL}/prove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(COMPLIANT_INPUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function verifyWithSnarkjs(proof, publicSignals) {
  const { groth16 } = await import('snarkjs');
  const vk = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
  return groth16.verify(vk, publicSignals, proof);
}

async function main() {
  console.log('Generating a valid proof via prover-service...');
  const response = await callProve();
  const { raw_proof: validProof, raw_public: validPublic } = response;
  console.log('  elapsed:', response.proving_time_ms, 'ms');
  console.log('  is_compliant (public):', validPublic[0]);

  console.log('\nVerifying ORIGINAL proof...');
  const okOriginal = await verifyWithSnarkjs(validProof, validPublic);
  console.log('  result:', okOriginal ? 'ACCEPTED' : 'REJECTED');
  if (!okOriginal) {
    console.error('Unexpected: original proof should verify.');
    process.exit(1);
  }

  console.log(
    '\nTampering with proof: flip a single field-element bit in pi_a[0]...',
  );
  const tamperedProof = JSON.parse(JSON.stringify(validProof));
  tamperedProof.pi_a[0] = stringBigIntAdd(tamperedProof.pi_a[0], '1');

  const okTampered = await verifyWithSnarkjs(tamperedProof, validPublic);
  console.log('  result:', okTampered ? 'ACCEPTED' : 'REJECTED');
  if (okTampered) {
    console.error('CRITICAL: tampered proof should NOT verify. Something is wrong.');
    process.exit(2);
  }

  console.log(
    '\nTampering with public inputs: flip is_compliant from 1 to 0...',
  );
  const tamperedPublic = [...validPublic];
  tamperedPublic[0] = '0';

  const okPublic = await verifyWithSnarkjs(validProof, tamperedPublic);
  console.log('  result:', okPublic ? 'ACCEPTED' : 'REJECTED');
  if (okPublic) {
    console.error('CRITICAL: mismatched public input should NOT verify.');
    process.exit(3);
  }

  console.log(
    '\nAll checks passed. The proof is cryptographically bound to both the',
  );
  console.log('proof bytes AND the public inputs — a fake prover could not do this.');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
