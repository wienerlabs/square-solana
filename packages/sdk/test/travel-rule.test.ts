// Travel Rule commitment'ı (BC-34, ADR 0015). Zincirdeki doğrulayıcının (crates/square-common,
// `travel_rule`) test ettiği vektörler bu paketin uygulamasından üretilir; dosya güncel olmalı
// (scripts/travel-rule-vectors.mjs).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { TRAVEL_RULE_DOMAIN, travelRule } from '../src/travel-rule.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const record = {
  originator: { name: 'Example Research Ltd', account: 'institution-wallet' },
  beneficiary: { name: 'Example Agent Operator', account: 'agent-wallet' },
  amount: '250000000',
  asset: 'USDC',
};

describe('travel-rule-vectors.json', () => {
  it("bu paketin ürettiği commitment'larla aynı", () => {
    const script = fileURLToPath(new URL('../scripts/travel-rule-vectors.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('dosyadaki her vektör yeniden hesaplanır', () => {
    const file = new URL('../../../crates/square-common/tests/fixtures/travel-rule-vectors.json', import.meta.url);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      domain: string;
      vectors: { job: string; salt: string; record: unknown; recordDigest: string; commitment: string }[];
    };
    expect(doc.domain).toBe(TRAVEL_RULE_DOMAIN);
    for (const v of doc.vectors) {
      const job = new PublicKey(v.job);
      const salt = Uint8Array.from(Buffer.from(v.salt, 'hex'));
      expect(hex(travelRule.recordDigest(v.record))).toBe(v.recordDigest);
      expect(hex(travelRule.commitment({ job, salt, record: v.record }))).toBe(v.commitment);
    }
  });
});

describe('travelRule', () => {
  const job = Keypair.generate().publicKey;
  const salt = new Uint8Array(32).fill(7);

  it("kaydın özeti anahtar sırasından bağımsız, RFC 8785 kanonik JSON'un SHA-256'sı", () => {
    const reordered = {
      asset: record.asset,
      amount: record.amount,
      beneficiary: record.beneficiary,
      originator: record.originator,
    };
    expect(hex(travelRule.recordDigest(reordered))).toBe(hex(travelRule.recordDigest(record)));
    const canonical =
      '{"amount":"250000000","asset":"USDC","beneficiary":{"account":"agent-wallet","name":"Example Agent Operator"},' +
      '"originator":{"account":"institution-wallet","name":"Example Research Ltd"}}';
    expect(hex(travelRule.recordDigest(record))).toBe(hex(sha256(new TextEncoder().encode(canonical))));
  });

  it("commitment işi, salt'ı ve kaydı bağlar", () => {
    const base = hex(travelRule.commitment({ job, salt, record }));
    expect(hex(travelRule.commitment({ job: Keypair.generate().publicKey, salt, record }))).not.toBe(base);
    expect(hex(travelRule.commitment({ job, salt: new Uint8Array(32).fill(8), record }))).not.toBe(base);
    expect(hex(travelRule.commitment({ job, salt, record: { ...record, amount: '250000001' } }))).not.toBe(base);
    expect(() => travelRule.commitment({ job, salt: new Uint8Array(31), record })).toThrow(/32 bayt/);
    expect(() => travelRule.recordDigest({ amount: Number.NaN })).toThrow(/sonlu olmayan/);
  });

  it('salt 32 rastgele bayt', () => {
    const a = travelRule.generateSalt();
    const b = travelRule.generateSalt();
    expect(a).toHaveLength(32);
    expect(hex(a)).not.toBe(hex(b));
  });
});
