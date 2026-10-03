// Adım 5: onaylı alıcı listesi Merkle ağacı (program-interface.md, "Alıcı listesi Merkle ağacı").
//   yaprak = sha256(buyer ‖ leaf_salt);  iç düğüm = sha256(min ‖ max);  tek kalan düğüm yukarı taşınır
//   boş liste = 32 sıfır bayt (kısıtsız);  kanıt en fazla 16 kardeş
import { sha256 } from '@noble/hashes/sha2';
import type { PublicKey } from '@solana/web3.js';

export const MAX_BUYER_PROOF_DEPTH = 16;

export interface BuyerEntry {
  buyer: PublicKey;
  /** Alıcıya özel 32 baytlık salt. */
  leafSalt: Uint8Array;
}

export interface BuyerTree {
  /** `set_buyer_root`'un argümanı. */
  root: Uint8Array;
  entries: readonly BuyerEntry[];
  /** Seviye seviye düğümler; 0. seviye yapraklar (entries sırasıyla). */
  levels: readonly (readonly Uint8Array[])[];
}

const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < 32; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};
const concat = (a: Uint8Array, b: Uint8Array) => Uint8Array.from([...a, ...b]);
const node = (a: Uint8Array, b: Uint8Array) => (compare(a, b) <= 0 ? sha256(concat(a, b)) : sha256(concat(b, a)));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && compare(a, b) === 0;

export function buyerLeaf(buyer: PublicKey, leafSalt: Uint8Array): Uint8Array {
  if (leafSalt.length !== 32) throw new Error('leafSalt 32 bayt olmalı');
  return sha256(concat(buyer.toBytes(), leafSalt));
}

export function generateLeafSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function buildBuyerTree(entries: readonly BuyerEntry[]): BuyerTree {
  if (entries.length > 2 ** MAX_BUYER_PROOF_DEPTH) throw new Error(`en fazla ${2 ** MAX_BUYER_PROOF_DEPTH} alıcı`);
  const buyers = new Set(entries.map((e) => e.buyer.toBase58()));
  if (buyers.size !== entries.length) throw new Error('alıcı listesinde tekrar var');
  if (entries.length === 0) return { root: new Uint8Array(32), entries, levels: [] };
  const levels: Uint8Array[][] = [entries.map((e) => buyerLeaf(e.buyer, e.leafSalt))];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    levels.push(
      Array.from({ length: Math.ceil(level.length / 2) }, (_, i) =>
        level[2 * i + 1] ? node(level[2 * i]!, level[2 * i + 1]!) : level[2 * i]!,
      ),
    );
  }
  return { root: levels.at(-1)![0]!, entries, levels };
}

/** `buy_claim` için alıcının salt'ı ve kanıtı (yapraktan köke kardeşler). */
export function getBuyerProof(tree: BuyerTree, buyer: PublicKey): { leafSalt: Uint8Array; merkleProof: Uint8Array[] } {
  const index = tree.entries.findIndex((e) => e.buyer.equals(buyer));
  if (index < 0) throw new Error(`alıcı listede değil: ${buyer.toBase58()}`);
  const proof: Uint8Array[] = [];
  let position = index;
  for (const level of tree.levels.slice(0, -1)) {
    const sibling = level[position ^ 1];
    if (sibling) proof.push(sibling);
    position = Math.floor(position / 2);
  }
  return { leafSalt: tree.entries[index]!.leafSalt, merkleProof: proof };
}

/** Kanıtı kökle karşılaştırır (zincirdeki `buy_claim` doğrulamasının karşılığı). Sıfır kök kısıtsızdır. */
export function verifyBuyerProof(
  root: Uint8Array,
  buyer: PublicKey,
  leafSalt: Uint8Array,
  proof: readonly Uint8Array[],
): boolean {
  if (root.every((b) => b === 0)) return true;
  if (proof.length > MAX_BUYER_PROOF_DEPTH) return false;
  return equal(proof.reduce(node, buyerLeaf(buyer, leafSalt)), root);
}
