import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  buildBuyerTree,
  buyerLeaf,
  generateLeafSalt,
  getBuyerProof,
  MAX_BUYER_PROOF_DEPTH,
  verifyBuyerProof,
} from '../src/buyers.js';

const entries = (n: number) =>
  Array.from({ length: n }, () => ({ buyer: Keypair.generate().publicKey, leafSalt: generateLeafSalt() }));

describe('alıcı Merkle ağacı', () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    it(`${n} alıcı: her kanıt köke ulaşır, yabancı ve yanlış salt reddedilir`, () => {
      const list = entries(n);
      const tree = buildBuyerTree(list);
      for (const { buyer } of list) {
        const { leafSalt, merkleProof } = getBuyerProof(tree, buyer);
        expect(merkleProof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)));
        expect(verifyBuyerProof(tree.root, buyer, leafSalt, merkleProof)).toBe(true);
        expect(verifyBuyerProof(tree.root, buyer, randomBytes(32), merkleProof)).toBe(false);
      }
      expect(
        verifyBuyerProof(
          tree.root,
          Keypair.generate().publicKey,
          list[0]!.leafSalt,
          getBuyerProof(tree, list[0]!.buyer).merkleProof,
        ),
      ).toBe(false);
      expect(() => getBuyerProof(tree, Keypair.generate().publicKey)).toThrow(/listede değil/);
    });
  }

  it('tek yaprak kökün kendisi; boş liste sıfır kök (kısıtsız)', () => {
    const [one] = entries(1);
    expect(buildBuyerTree([one!]).root).toEqual(buyerLeaf(one!.buyer, one!.leafSalt));
    const empty = buildBuyerTree([]);
    expect(empty.root).toEqual(new Uint8Array(32));
    expect(verifyBuyerProof(empty.root, Keypair.generate().publicKey, randomBytes(32), [])).toBe(true);
  });

  it('iç düğüm sıralı çift: kardeş sırası kökü değiştirmez', () => {
    const [a, b] = entries(2);
    expect(buildBuyerTree([a!, b!]).root).toEqual(buildBuyerTree([b!, a!]).root);
  });

  it('tekrar eden alıcı, bozuk salt ve derinlik sınırı', () => {
    const [a] = entries(1);
    expect(() => buildBuyerTree([a!, { ...a!, leafSalt: generateLeafSalt() }])).toThrow(/tekrar/);
    expect(() => buyerLeaf(a!.buyer, new Uint8Array(31))).toThrow(/32 bayt/);
    const tooDeep = Array.from({ length: MAX_BUYER_PROOF_DEPTH + 1 }, () => randomBytes(32));
    expect(verifyBuyerProof(randomBytes(32), a!.buyer, a!.leafSalt, tooDeep)).toBe(false);
  });
});
