import { createHash } from 'node:crypto';

export function computeProofHash(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function computeBatchHash(proofHashes: readonly string[]): string {
  const sorted = [...proofHashes].sort();
  const concatenated = sorted.join(':');
  return createHash('sha256').update(concatenated).digest('hex');
}
