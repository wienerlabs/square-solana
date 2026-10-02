#!/usr/bin/env node
// Submit a real verify_payment_proof_v2 transaction to Solana devnet.
//
// Bypasses the dashboard to isolate where a failing payment flow breaks:
// if this script succeeds, the Circom proof + groth16-solana on-chain
// verification pipeline is healthy end-to-end, and any dashboard failure
// is a UI-side issue (account wiring, policy PDA, etc.).
//
// Usage:
//   node services/prover-service/scripts/devnet-verify-test.mjs
//
// Requires the local prover-service at http://localhost:3003 and a funded
// devnet keypair at ~/.config/solana/id.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const PROVER_URL = process.env.PROVER_URL ?? 'http://localhost:3003';
const VERIFIER_PROGRAM_ID = new PublicKey(
  'AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU',
);
const POLICY_REGISTRY_PROGRAM_ID = new PublicKey(
  'FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU',
);

// Anchor discriminator for verify_payment_proof_v2 (from IDL)
const DISCRIMINATOR_V2 = Buffer.from([15, 218, 30, 217, 205, 0, 219, 86]);

function loadWallet() {
  const keyPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  const raw = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function requestProof() {
  const body = {
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
  const res = await fetch(`${PROVER_URL}/prove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`prover HTTP ${res.status}`);
  return res.json();
}

function decodeB64(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function deriveProofRecordPda(operator, journalDigestBytes) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('proof'), operator.toBuffer(), Buffer.from(journalDigestBytes)],
    VERIFIER_PROGRAM_ID,
  );
}

function deriveComplianceStatusPda(operator) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('compliance'), operator.toBuffer()],
    VERIFIER_PROGRAM_ID,
  );
}

async function main() {
  const wallet = loadWallet();
  console.log('operator  :', wallet.publicKey.toBase58());
  console.log('rpc       :', RPC_URL);
  console.log('verifier  :', VERIFIER_PROGRAM_ID.toBase58());

  console.log('\nFetching fresh proof from prover-service...');
  const proof = await requestProof();
  console.log('  elapsed         :', proof.proving_time_ms, 'ms');
  console.log('  is_compliant    :', proof.is_compliant);
  console.log('  journal_digest  :', proof.journal_digest);

  const proofA = decodeB64(proof.groth16.proof_a);
  const proofB = decodeB64(proof.groth16.proof_b);
  const proofC = decodeB64(proof.groth16.proof_c);
  const publicInputs = proof.groth16.public_inputs.map(decodeB64);

  console.log('\nInstruction byte sizes:');
  console.log('  proof_a         :', proofA.length, '(expect 64)');
  console.log('  proof_b         :', proofB.length, '(expect 128)');
  console.log('  proof_c         :', proofC.length, '(expect 64)');
  console.log('  public_inputs[0]:', publicInputs[0].length, '(expect 32)');
  console.log('  public_inputs[1]:', publicInputs[1].length, '(expect 32)');

  const journalDigestBytes = publicInputs[1];
  const [proofRecordPda] = deriveProofRecordPda(
    wallet.publicKey,
    journalDigestBytes,
  );
  const [complianceStatusPda] = deriveComplianceStatusPda(wallet.publicKey);

  // The policy_account is only stored in the ProofRecord as a reference. For
  // this smoke test we pass the verifier program itself — any non-writable
  // UncheckedAccount is acceptable to the on-chain handler.
  const policyAccount = VERIFIER_PROGRAM_ID;

  const data = Buffer.alloc(8 + 64 + 128 + 64 + 64);
  let off = 0;
  DISCRIMINATOR_V2.copy(data, off); off += 8;
  Buffer.from(proofA).copy(data, off); off += 64;
  Buffer.from(proofB).copy(data, off); off += 128;
  Buffer.from(proofC).copy(data, off); off += 64;
  Buffer.from(publicInputs[0]).copy(data, off); off += 32;
  Buffer.from(publicInputs[1]).copy(data, off); off += 32;

  const ix = new TransactionInstruction({
    programId: VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofRecordPda, isSigner: false, isWritable: true },
      { pubkey: complianceStatusPda, isSigner: false, isWritable: true },
      { pubkey: policyAccount, isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const connection = new Connection(RPC_URL, 'confirmed');
  const tx = new Transaction().add(ix);

  console.log('\nSimulating transaction...');
  tx.feePayer = wallet.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  try {
    const sim = await connection.simulateTransaction(tx, [wallet]);
    if (sim.value.err) {
      console.error('Simulation failed:', JSON.stringify(sim.value.err, null, 2));
      console.error('\nLogs:');
      for (const log of sim.value.logs ?? []) console.error('  ', log);
      process.exit(2);
    }
    console.log('  simulation ok, compute units consumed:', sim.value.unitsConsumed);
    console.log('\nLogs:');
    for (const log of sim.value.logs ?? []) console.log('  ', log);
  } catch (err) {
    console.error('simulation threw:', err.message);
    process.exit(3);
  }

  console.log('\nSubmitting real transaction to devnet...');
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log('  tx signature:', sig);
  console.log(
    '  explorer    :',
    `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  );
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
