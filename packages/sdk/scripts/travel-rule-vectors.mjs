#!/usr/bin/env node
// Travel Rule commitment'ının test vektörleri (BC-34, ADR 0015). Commitment'lar bu paketin uygulamasıyla
// (`travelRule`) üretilir; zincirdeki karşılığı (crates/square-common, `travel_rule`) aynı dosyayı doğrular.
// Job adresleri ve salt'lar etiketlerden türetilir, kayıtlar örnek veridir; hiçbiri sır değildir.
//   node scripts/travel-rule-vectors.mjs          dosyayı yazar (önce `pnpm build`)
//   node scripts/travel-rule-vectors.mjs --check  dosya güncel değilse 1 ile çıkar
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2';
import { PublicKey } from '@solana/web3.js';
// Yalnızca commitment modülü: paketin girişi spl-token'ı (ve bigint-buffer uyarısını) yükler.
import { canonicalJson } from '../dist/canonical.js';
import { TRAVEL_RULE_DOMAIN, travelRule } from '../dist/travel-rule.js';

const OUT = new URL('../../../crates/square-common/tests/fixtures/travel-rule-vectors.json', import.meta.url);

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const derive = (label) => sha256(new TextEncoder().encode(`square/travel-rule-vectors/${label}`));

// Örnek kayıtlar: kaynak ve hedef taraf, tutar ve varlık. Kaydın şeması BE-23'ündür; vektörler yalnızca
// kanonikleştirmenin ve commitment'ın iki uygulamada aynı olduğunu sınar (anahtar sırası, Unicode).
const RECORDS = [
  {
    label: 'basic',
    record: {
      originator: { name: 'Example Research Ltd', account: 'institution-wallet' },
      beneficiary: { name: 'Example Agent Operator', account: 'agent-wallet' },
      amount: '1000000000',
      asset: 'USDC',
    },
  },
  {
    label: 'unicode-and-order',
    record: {
      beneficiary: { name: 'Ağ Ölçüm Şirketi', country: 'TR' },
      originator: { name: 'Zürich Lab', country: 'CH', identifiers: ['LEI-0001', 'VAT-42'] },
      amount: '250000000',
      asset: 'USDC',
    },
  },
  { label: 'minimal', record: { originator: { name: 'A' }, beneficiary: { name: 'B' } } },
];

export function travelRuleVectors() {
  return {
    domain: TRAVEL_RULE_DOMAIN,
    vectors: RECORDS.map(({ label, record }) => {
      const job = new PublicKey(derive(`${label}/job`));
      const salt = derive(`${label}/salt`);
      return {
        label,
        job: job.toBase58(),
        salt: hex(salt),
        record,
        canonical: canonicalJson(record, 'record'),
        recordDigest: hex(travelRule.recordDigest(record)),
        commitment: hex(travelRule.commitment({ job, salt, record })),
      };
    }),
  };
}

const text = `${JSON.stringify(travelRuleVectors(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('travel-rule-vectors.json güncel değil: node scripts/travel-rule-vectors.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
