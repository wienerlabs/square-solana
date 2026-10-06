// Travel Rule commitment'ı (BC-34, ADR 0015). Eşiği aşan işte kurum fonlamadan önce kaydın salt'lı
// commitment'ını job'a bağlar (`commit_travel_rule`); kişisel veri zincire çıkmaz. Kayıt ve salt zincir
// dışında, şifreli saklanır (BE-23). Zincirdeki karşılığı `square_common::travel_rule`; iki uygulamanın
// uyumu ortak test vektörleriyle denetlenir (`scripts/travel-rule-vectors.mjs`).
import { sha256 } from '@noble/hashes/sha2';
import type { PublicKey } from '@solana/web3.js';
import { canonicalJson } from './canonical.js';

/** Commitment'ın alan ayırıcısı (sürümlü). */
export const TRAVEL_RULE_DOMAIN = 'square/travel-rule/v1';

/** Travel Rule kaydının özeti ve zincire giden commitment'ı (ADR 0015). */
export interface TravelRuleHashing {
  /** Kaydın özeti: SHA-256(RFC 8785 kanonik JSON), 32 bayt. */
  recordDigest(record: unknown): Uint8Array;
  /** `sha256(DOMAIN ‖ job ‖ salt ‖ recordDigest(record))`; job adresi commitment'ı tek bir işe bağlar. */
  commitment(params: { job: PublicKey; salt: Uint8Array; record: unknown }): Uint8Array;
  /** Commitment'ın 32 baytlık rastgele salt'ı (CSPRNG); kayıtla birlikte saklanır. */
  generateSalt(): Uint8Array;
}

const encoder = new TextEncoder();

const recordDigest = (record: unknown): Uint8Array => sha256(encoder.encode(canonicalJson(record, 'record')));

/** `TravelRuleHashing`'in uygulaması. */
export const travelRule: TravelRuleHashing = {
  recordDigest,
  commitment({ job, salt, record }) {
    if (salt.length !== 32) throw new Error(`salt 32 bayt olmalı, ${salt.length} bayt`);
    const parts = [encoder.encode(TRAVEL_RULE_DOMAIN), job.toBytes(), salt, recordDigest(record)];
    const message = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    parts.reduce((offset, part) => {
      message.set(part, offset);
      return offset + part.length;
    }, 0);
    return sha256(message);
  },
  generateSalt: () => crypto.getRandomValues(new Uint8Array(32)),
};
