// Onaylı alıcının kanıt dosyası (FE-08). Kurumun alıcı listesi ve salt'ları kurumun tarayıcısında kalır
// (FE-04); kurum her alıcıya yalnızca onun salt'ını ve Merkle kanıtını içeren bir dosya verir. Alıcı dosyayı
// alım sırasında yükler; dosya zincirdeki güncel köke karşı tarayıcıda denetlenir, `buy_claim` aynı
// doğrulamayı zincirde yapar (`square_common::merkle`).
import { PublicKey } from '@solana/web3.js';
import { getBuyerProof, verifyBuyerProof, type BuyerTree } from '@squaresdk/solana-policy';
import { z } from 'zod';
import type { BuyerList } from './claim-market';
import { bytesToHex, hexToBytes } from './policy-draft';

export const BUYER_PROOF_KIND = 'square-buyer-proof';

const HEX32 = /^[0-9a-f]{64}$/;

const fileSchema = z.object({
  kind: z.literal(BUYER_PROOF_KIND),
  version: z.literal(1),
  cluster: z.string(),
  policy: z.string(),
  buyerRoot: z.string().regex(HEX32),
  buyer: z.string(),
  leafSalt: z.string().regex(HEX32),
  merkleProof: z.array(z.string().regex(HEX32)).max(16),
});

export type BuyerProofFile = z.infer<typeof fileSchema>;

export interface BuyerProof {
  cluster: string;
  policy: PublicKey;
  buyerRoot: Uint8Array;
  buyer: PublicKey;
  leafSalt: Uint8Array;
  merkleProof: Uint8Array[];
}

/** Kurumun yayımladığı ağaçtan bir alıcının kanıt dosyası. */
export function createBuyerProofFile(params: {
  cluster: string;
  policy: PublicKey;
  tree: BuyerTree;
  buyer: PublicKey;
}): BuyerProofFile {
  const { leafSalt, merkleProof } = getBuyerProof(params.tree, params.buyer);
  return {
    kind: BUYER_PROOF_KIND,
    version: 1,
    cluster: params.cluster,
    policy: params.policy.toBase58(),
    buyerRoot: bytesToHex(params.tree.root),
    buyer: params.buyer.toBase58(),
    leafSalt: bytesToHex(leafSalt),
    merkleProof: merkleProof.map(bytesToHex),
  };
}

const publicKey = (value: string) => {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
};

export function parseBuyerProofFile(text: string): { ok: true; proof: BuyerProof } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not JSON.' };
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'This is not a Square buyer proof file.' };
  const policy = publicKey(parsed.data.policy);
  const buyer = publicKey(parsed.data.buyer);
  if (!policy || !buyer) return { ok: false, error: 'This is not a Square buyer proof file.' };
  return {
    ok: true,
    proof: {
      cluster: parsed.data.cluster,
      policy,
      buyerRoot: hexToBytes(parsed.data.buyerRoot),
      buyer,
      leafSalt: hexToBytes(parsed.data.leafSalt),
      merkleProof: parsed.data.merkleProof.map(hexToBytes),
    },
  };
}

export type Eligibility =
  | { state: 'eligible'; leafSalt: Uint8Array; merkleProof: Uint8Array[] }
  | { state: 'needsProof' }
  | { state: 'refused'; reason: string };

const NO_SALT = new Uint8Array(32);

/**
 * Bağlı cüzdanın bu işin alacağını alıp alamayacağı, `buy_claim`'in kuralıyla: liste yoksa ya da kök
 * sıfırsa kanıt gerekmez; kök varsa kanıt bu politikanın güncel köküne ve bu cüzdana ait olmalıdır.
 */
export function buyerEligibility(params: {
  buyers: BuyerList;
  buyer: PublicKey;
  cluster: string;
  proof: BuyerProof | null;
}): Eligibility {
  const { buyers, buyer, cluster, proof } = params;
  if (buyers.kind !== 'approved') return { state: 'eligible', leafSalt: NO_SALT, merkleProof: [] };
  if (!proof) return { state: 'needsProof' };
  if (proof.cluster !== cluster)
    return { state: 'refused', reason: `This proof is for ${proof.cluster}, not ${cluster}.` };
  if (!proof.policy.equals(buyers.policy)) {
    return { state: 'refused', reason: `This proof is for another policy (${proof.policy.toBase58()}).` };
  }
  if (!proof.buyer.equals(buyer)) {
    return { state: 'refused', reason: `This proof is for the wallet ${proof.buyer.toBase58()}; connect that wallet.` };
  }
  if (verifyBuyerProof(buyers.root, buyer, proof.leafSalt, proof.merkleProof)) {
    return { state: 'eligible', leafSalt: proof.leafSalt, merkleProof: proof.merkleProof };
  }
  const sameRoot = proof.buyerRoot.every((byte, i) => byte === buyers.root[i]);
  return {
    state: 'refused',
    reason: sameRoot
      ? "Your wallet is not on the institution's approved buyer list."
      : 'The institution has changed its buyer list since this proof was made. Ask it for a proof from the current list.',
  };
}
