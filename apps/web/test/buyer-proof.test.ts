// Onaylı alıcının kanıt dosyası (FE-08): kurumun ağacından dosya, dosyanın okunması ve alıcı uygunluğu,
// `buy_claim`'in kuralıyla. Ağaç `@squaresdk/solana-policy`'nin; zincirdeki doğrulamayla uyumu ortak test
// vektörleriyle denetlenir (buyer-merkle-vectors.json).
import { Keypair, PublicKey } from '@solana/web3.js';
import { buildBuyerTree, generateLeafSalt } from '@squaresdk/solana-policy';
import { describe, expect, it } from 'vitest';
import { buyerEligibility, createBuyerProofFile, parseBuyerProofFile, type BuyerProof } from '@/lib/buyer-proof';
import type { BuyerList } from '@/lib/claim-market';

const key = () => Keypair.generate().publicKey;
const policy = key();
const [alice, bob, carol, outsider] = [key(), key(), key(), key()];
const tree = buildBuyerTree([alice, bob, carol].map((buyer) => ({ buyer, leafSalt: generateLeafSalt() })));
const approved: BuyerList = { kind: 'approved', policy, root: tree.root };

/** Dosya kurumdan alıcıya JSON olarak gider; testler de o yoldan okur. */
const fileFor = (buyer: PublicKey, from = tree, cluster = 'devnet'): BuyerProof => {
  const parsed = parseBuyerProofFile(JSON.stringify(createBuyerProofFile({ cluster, policy, tree: from, buyer })));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.proof;
};
const check = (buyer: PublicKey, proof: BuyerProof | null, buyers: BuyerList = approved) =>
  buyerEligibility({ buyers, buyer, cluster: 'devnet', proof });

describe('buyer proof file', () => {
  it('lets a listed buyer buy with its own file', () => {
    for (const buyer of [alice, bob, carol]) {
      const result = check(buyer, fileFor(buyer));
      expect(result.state).toBe('eligible');
    }
    const result = check(carol, fileFor(carol));
    if (result.state !== 'eligible') throw new Error(result.state);
    expect(result.leafSalt).toEqual(tree.entries[2]!.leafSalt);
    // Üç yapraklı ağaçta üçüncü yaprağın eşi yok, yukarı taşınır: tek kardeş.
    expect(result.merkleProof).toHaveLength(1);
  });

  it('carries only the buyer’s own salt', () => {
    const file = createBuyerProofFile({ cluster: 'devnet', policy, tree, buyer: alice });
    expect(Object.keys(file).sort()).toEqual(
      ['buyer', 'buyerRoot', 'cluster', 'kind', 'leafSalt', 'merkleProof', 'policy', 'version'].sort(),
    );
    const others = tree.entries.slice(1).map((e) => Buffer.from(e.leafSalt).toString('hex'));
    expect(others.some((salt) => JSON.stringify(file).includes(salt))).toBe(false);
  });

  it('tells a buyer that is not on the list', () => {
    // Listede olmayan cüzdan kendi adresiyle bir dosya uydursa da kök tutmaz.
    const forged = { ...fileFor(alice), buyer: outsider };
    expect(check(outsider, forged)).toEqual({
      state: 'refused',
      reason: "Your wallet is not on the institution's approved buyer list.",
    });
    expect(check(outsider, null)).toEqual({ state: 'needsProof' });
  });

  it('tells which wallet, policy and cluster a file belongs to', () => {
    expect(check(outsider, fileFor(alice))).toEqual({
      state: 'refused',
      reason: `This proof is for the wallet ${alice.toBase58()}; connect that wallet.`,
    });
    const otherPolicy: BuyerList = { kind: 'approved', policy: key(), root: tree.root };
    expect(check(alice, fileFor(alice), otherPolicy)).toEqual({
      state: 'refused',
      reason: `This proof is for another policy (${policy.toBase58()}).`,
    });
    expect(check(alice, fileFor(alice, tree, 'mainnet-beta'))).toEqual({
      state: 'refused',
      reason: 'This proof is for mainnet-beta, not devnet.',
    });
  });

  it('notices a file from a list the institution has since replaced', () => {
    const before = fileFor(alice);
    const after = buildBuyerTree([...tree.entries, { buyer: outsider, leafSalt: generateLeafSalt() }]);
    const current: BuyerList = { kind: 'approved', policy, root: after.root };
    expect(check(alice, before, current)).toEqual({
      state: 'refused',
      reason:
        'The institution has changed its buyer list since this proof was made. Ask it for a proof from the current list.',
    });
    expect(check(alice, fileFor(alice, after), current).state).toBe('eligible');
  });

  it('needs no proof without a published list', () => {
    const none = check(outsider, null, { kind: 'none' });
    const open = check(outsider, null, { kind: 'open', policy });
    // Sıfır kökte `buy_claim` kanıta bakmaz; boş kanıt ve sıfır salt gider.
    expect(none).toEqual({ state: 'eligible', leafSalt: new Uint8Array(32), merkleProof: [] });
    expect(open).toEqual(none);
  });

  it('rejects what is not a buyer proof', () => {
    expect(parseBuyerProofFile('{')).toEqual({ ok: false, error: 'This file is not JSON.' });
    expect(parseBuyerProofFile('{"kind":"square-policy-backup"}')).toEqual({
      ok: false,
      error: 'This is not a Square buyer proof file.',
    });
    const file = createBuyerProofFile({ cluster: 'devnet', policy, tree, buyer: alice });
    expect(parseBuyerProofFile(JSON.stringify({ ...file, buyer: 'not-a-key' })).ok).toBe(false);
    expect(parseBuyerProofFile(JSON.stringify({ ...file, merkleProof: Array(17).fill(file.leafSalt) })).ok).toBe(false);
  });
});
