#!/usr/bin/env node
// Release kurallarının test vektörleri (ADR 0012, ADR 0013): ret kodunun kuralları ve kesinliği, günlük
// sayacın etkin değeri, ispatın tazeliği. Beklenen değerler bu paketin uygulamasıyla (`release.ts`)
// üretilir; zincirdeki kurallar (crates/square-common, `release`) aynı dosyayı doğrular. Adresler
// etiketlerden türetilir.
//   node scripts/release-vectors.mjs          dosyayı yazar (önce `pnpm build`)
//   node scripts/release-vectors.mjs --check  dosya güncel değilse 1 ile çıkar
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2';
import { PublicKey } from '@solana/web3.js';
// Yalnızca kural modülü: paketin girişi SDK'yı (ve spl-token'ın bigint-buffer uyarısını) yükler.
import { checkFresh, dailySpentAt, dayStart, isFinalRefusal, preflightAccepts, refusalRules } from '../dist/release.js';

const OUT = new URL('../../../crates/square-common/tests/fixtures/release-rule-vectors.json', import.meta.url);

const key = (label) => new PublicKey(sha256(new TextEncoder().encode(`square/release-vectors/${label}`)));
const hex = (pubkey) => Buffer.from(pubkey.toBytes()).toString('hex');

// Bir UTC gününün içinden bir an ve o günün başı (Rust testlerindeki NOW ve DAY).
const NOW = 1_790_000_000;
const DAY = dayStart(NOW);
const NEXT_DAY = DAY + 86_400;

export function refusalVectors() {
  return [0n, 40_000_000n].flatMap((dailySpentBefore) =>
    Array.from({ length: 128 }, (_, code) => ({
      code,
      dailySpentBefore: dailySpentBefore.toString(),
      rules: refusalRules(code),
      final: isFinalRefusal(code, dailySpentBefore),
      preflight: preflightAccepts(code),
    })),
  );
}

export function dailySpentVectors() {
  const cases = [
    { name: 'same day', dayStartUnix: DAY, dailySpent: 40_000_000n, at: NOW },
    { name: 'first second of the day', dayStartUnix: DAY, dailySpent: 40_000_000n, at: DAY },
    { name: 'last second of the day', dayStartUnix: DAY, dailySpent: 40_000_000n, at: NEXT_DAY - 1 },
    { name: 'state from an earlier day', dayStartUnix: DAY - 86_400, dailySpent: 40_000_000n, at: NOW },
    { name: 'state from a later day', dayStartUnix: NEXT_DAY, dailySpent: 40_000_000n, at: NOW },
    { name: 'new state', dayStartUnix: 0, dailySpent: 0n, at: NOW },
    { name: 'moment at the epoch', dayStartUnix: 0, dailySpent: 7n, at: 0 },
    { name: 'moment before the epoch', dayStartUnix: 0, dailySpent: 7n, at: -5 },
  ];
  return cases.map(({ name, dayStartUnix, dailySpent, at }) => {
    const expected = dailySpentAt(dayStartUnix, dailySpent, at);
    return {
      name,
      dayStartUnix,
      dailySpent: dailySpent.toString(),
      at,
      expected: expected === null ? null : expected.toString(),
    };
  });
}

export function freshnessVectors() {
  const payee = key('payee');
  const mint = key('mint');
  const proof = { payee, netAmount: 248_750_000n, mint, dailySpentBefore: 40_000_000n, proofTimestamp: NOW };
  const operator = { dayStartUnix: DAY, dailySpent: 40_000_000n };
  const target = { payee, netAmount: 248_750_000n, mint };
  const cases = [
    { name: 'fresh an hour later', now: NOW + 3_600 },
    { name: 'fresh until the last second of the day', now: NEXT_DAY - 1 },
    { name: 'receivable sold after the proof', target: { payee: key('buyer') } },
    { name: 'net amount changed', target: { netAmount: 248_750_001n } },
    { name: 'another mint', target: { mint: key('other-mint') } },
    { name: 'next UTC day', now: NEXT_DAY },
    {
      name: 'next UTC day with the counter unchanged',
      proof: { proofTimestamp: DAY - 60, dailySpentBefore: 0n },
      operator: { dayStartUnix: DAY - 86_400, dailySpent: 0n },
      now: DAY + 120,
    },
    { name: 'another release moved the counter', operator: { dailySpent: 140_000_000n } },
    { name: 'counter state from a later day', operator: { dayStartUnix: NEXT_DAY } },
    {
      name: 'counter state from an earlier day reads as 0',
      proof: { dailySpentBefore: 0n },
      operator: { dayStartUnix: DAY - 86_400, dailySpent: 500_000_000n },
    },
    { name: 'payee is checked before the day', target: { payee: key('buyer') }, now: NEXT_DAY },
    { name: 'net is checked before the mint', target: { netAmount: 1n, mint: key('other-mint') } },
  ];
  return cases.map((c) => {
    const p = { ...proof, ...c.proof };
    const o = { ...operator, ...c.operator };
    const t = { ...target, ...c.target };
    const now = c.now ?? NOW + 60;
    return {
      name: c.name,
      proof: {
        payee: hex(p.payee),
        netAmount: p.netAmount.toString(),
        mint: hex(p.mint),
        dailySpentBefore: p.dailySpentBefore.toString(),
        proofTimestamp: p.proofTimestamp,
      },
      operator: { dayStartUnix: o.dayStartUnix, dailySpent: o.dailySpent.toString() },
      target: { payee: hex(t.payee), netAmount: t.netAmount.toString(), mint: hex(t.mint) },
      now,
      expected: checkFresh(p, o, t, now),
    };
  });
}

const text = `${JSON.stringify(
  { refusals: refusalVectors(), dailySpentAt: dailySpentVectors(), fresh: freshnessVectors() },
  null,
  2,
)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('release-rule-vectors.json güncel değil: node scripts/release-vectors.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
