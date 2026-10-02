import { createHash } from 'node:crypto';

export function computeProofHash(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function computeBatchHash(
  proofHashes: readonly string[],
  periodStart: Date,
  periodEnd: Date
): string {
  const sorted = [...proofHashes].sort();
  const concatenated = sorted.join(':');
  // Include the period bounds so two attestations covering the same proof set
  // (possible across overlapping windows or replayed runs) produce distinct
  // batch_hashes -- otherwise the on-chain attestation_record PDA collides
  // with `init` and the anchor TX fails with "account already in use".
  const payload = `${concatenated}|${periodStart.toISOString()}|${periodEnd.toISOString()}`;
  return createHash('sha256').update(payload).digest('hex');
}
