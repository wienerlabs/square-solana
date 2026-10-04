#!/usr/bin/env node
// Alıcı Merkle ağacının test vektörleri (BC-18). Ağaç ve kanıtlar bu paketin uygulamasıyla
// (`buildBuyerTree`, `getBuyerProof`) üretilir; zincirdeki doğrulayıcı (crates/square-common, `merkle`)
// aynı dosyadaki kanıtları doğrular. Alıcılar ve salt'lar etiketlerden türetilir; sır değildir.
//   node scripts/buyer-vectors.mjs          dosyayı yazar (önce `pnpm build`)
//   node scripts/buyer-vectors.mjs --check  dosya güncel değilse 1 ile çıkar
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2';
import { PublicKey } from '@solana/web3.js';
import { buildBuyerTree, getBuyerProof } from '../dist/index.js';

const OUT = new URL('../../../crates/square-common/tests/fixtures/buyer-merkle-vectors.json', import.meta.url);
const SIZES = [1, 2, 3, 5, 8, 17];

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const derive = (label) => sha256(new TextEncoder().encode(`square/buyer-vectors/${label}`));

export function buyerVectors() {
  return SIZES.map((size) => {
    const entries = Array.from({ length: size }, (_, i) => ({
      buyer: new PublicKey(derive(`${size}/buyer/${i}`)),
      leafSalt: derive(`${size}/salt/${i}`),
    }));
    const tree = buildBuyerTree(entries);
    return {
      size,
      root: hex(tree.root),
      buyers: entries.map(({ buyer }) => {
        const { leafSalt, merkleProof } = getBuyerProof(tree, buyer);
        return { buyer: hex(buyer.toBytes()), leafSalt: hex(leafSalt), proof: merkleProof.map(hex) };
      }),
    };
  });
}

const text = `${JSON.stringify({ trees: buyerVectors() }, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('buyer-merkle-vectors.json güncel değil: node scripts/buyer-vectors.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
