// Kaynak sonuçlarının birleşimi ve zincire yazılan `source_hash`. Kaynaklardan herhangi biri işaretlerse
// karar `flagged`'dır; hepsi temizse `clear`. Kanıt belgesi cüzdanı ve kaynakların kanıtlarını (ada göre
// sıralı) içerir; `source_hash` belgenin RFC 8785 (JCS) kanonik JSON'unun SHA-256'sıdır. Zaman belgeye
// girmez: aynı liste sürümü ve aynı sağlayıcı yanıtı aynı hash'i verir. Belge denetim kaydında saklanır;
// zincirdeki hash ondan yeniden hesaplanarak doğrulanır.
import { createHash } from 'node:crypto';
import { specHashing } from '@squaresdk/solana-sdk';
import type { SourceResult } from './sources/source.js';

/** Kanıt belgesinin biçim sürümü. */
export const EVIDENCE_VERSION = 1;

export type ScreeningStatus = 'clear' | 'flagged';

export interface Evidence {
  readonly version: number;
  readonly wallet: string;
  readonly sources: readonly ({ readonly source: string; readonly flagged: boolean } & Record<string, unknown>)[];
}

export interface Decision {
  readonly status: ScreeningStatus;
  readonly evidence: Evidence;
  /** 32 bayt; `record_screening`'in `source_hash` argümanı. */
  readonly sourceHash: Uint8Array;
}

/** Kanıt belgesinin hash'i (küçük harf hex için `Buffer.from(...).toString('hex')`). */
export function evidenceHash(evidence: Evidence): Uint8Array {
  // `canonicalizeSpec` RFC 8785 kanonik JSON'dur; job spec'iyle aynı kodlama.
  return createHash('sha256').update(specHashing.canonicalizeSpec(evidence), 'utf8').digest();
}

export function decide(wallet: string, results: readonly SourceResult[]): Decision {
  if (results.length === 0) throw new Error('en az bir kaynak sonucu gerekli');
  const sources = [...results]
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((result) => ({ ...result.evidence, source: result.source, flagged: result.flagged }));
  const evidence: Evidence = { version: EVIDENCE_VERSION, wallet, sources };
  return {
    status: results.some((result) => result.flagged) ? 'flagged' : 'clear',
    evidence,
    sourceHash: evidenceHash(evidence),
  };
}
