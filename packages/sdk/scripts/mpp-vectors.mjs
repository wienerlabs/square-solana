#!/usr/bin/env node
// Stripe MPP attestation'ının test vektörleri (BC-37, ADR 0024). Mesajlar ve Ed25519 precompile talimatları bu
// paketin uygulamasıyla (`mppAttestationMessage`, `mppAttestationInstruction`) üretilir; zincirdeki karşılığı
// (crates/square-common, `mpp`) aynı dosyayı doğrular. Job adresleri, makbuz commitment'ları ve imza anahtarı
// etiketlerden türetilir; hiçbiri sır değildir.
//   node scripts/mpp-vectors.mjs          dosyayı yazar (önce `pnpm build`)
//   node scripts/mpp-vectors.mjs --check  dosya güncel değilse 1 ile çıkar
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2';
import { Ed25519Program, Keypair, PublicKey } from '@solana/web3.js';
// Yalnızca MPP modülü: paketin girişi spl-token'ı (ve bigint-buffer uyarısını) yükler.
import { MPP_ATTESTATION_DOMAIN, mppAttestationInstruction, mppAttestationMessage } from '../dist/mpp.js';

const OUT = new URL('../../../crates/square-common/tests/fixtures/mpp-attestation-vectors.json', import.meta.url);

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const derive = (label) => sha256(new TextEncoder().encode(`square/mpp-attestation-vectors/${label}`));

// Tutarlar: en küçük, fikstürdeki fiat işin tutarı (30 USDC) ve u64'ün üst sınırı.
const CASES = [
  { label: 'smallest', amount: 1n },
  { label: 'thirty-usdc', amount: 30_000_000n },
  { label: 'u64-max', amount: 2n ** 64n - 1n },
];

export function mppVectors() {
  const authority = Keypair.fromSeed(derive('authority'));
  return {
    domain: MPP_ATTESTATION_DOMAIN,
    authority: authority.publicKey.toBase58(),
    vectors: CASES.map(({ label, amount }) => {
      const job = new PublicKey(derive(`${label}/job`));
      const stripeReceiptHash = derive(`${label}/receipt`);
      const message = mppAttestationMessage({ job, stripeReceiptHash, amount });
      const signed = Ed25519Program.createInstructionWithPrivateKey({ privateKey: authority.secretKey, message });
      const signature = signed.data.subarray(16 + 32, 16 + 32 + 64);
      const instruction = mppAttestationInstruction({ authority: authority.publicKey, message, signature });
      return {
        label,
        job: job.toBase58(),
        stripeReceiptHash: hex(stripeReceiptHash),
        amount: amount.toString(),
        message: hex(message),
        instruction: hex(instruction.data),
      };
    }),
  };
}

const text = `${JSON.stringify(mppVectors(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('mpp-attestation-vectors.json güncel değil: node scripts/mpp-vectors.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
