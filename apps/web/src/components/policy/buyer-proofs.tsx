'use client';

import { PublicKey } from '@solana/web3.js';
import type { BuyerTree } from '@squaresdk/solana-policy';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { createBuyerProofFile } from '@/lib/buyer-proof';

function download(cluster: string, policy: PublicKey, tree: BuyerTree, buyer: PublicKey) {
  const file = createBuyerProofFile({ cluster, policy, tree, buyer });
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `square-buyer-proof-${cluster}-${buyer.toBase58()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Yayımlanmış listedeki her alıcının kanıt dosyası (FE-08). Dosya yalnızca o alıcının salt'ını ve Merkle
 * kanıtını taşır; liste ve diğer alıcıların salt'ları bu tarayıcıda kalır. Liste değişince eski dosyalar
 * geçersizleşir.
 */
export function BuyerProofs({ cluster, policy, tree }: { cluster: string; policy: string; tree: BuyerTree }) {
  const policyKey = new PublicKey(policy);
  return (
    <div>
      <h3 className="text-sm font-medium">Buyer proofs</h3>
      <p className="mt-1 text-caption text-muted">
        The buyer list on chain matches the draft. Give each buyer its own proof file: it holds only that buyer&apos;s
        salt and Merkle proof, and the buyer loads it to buy a receivable of this policy. Publishing a new list makes
        the files of the old one invalid.
      </p>
      <ul aria-label="Buyer proofs" className="mt-2 grid gap-2 text-sm">
        {tree.entries.map(({ buyer }) => (
          <li
            key={buyer.toBase58()}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2"
          >
            <Address value={buyer.toBase58()} label="buyer" />
            <Button size="sm" variant="secondary" onClick={() => download(cluster, policyKey, tree, buyer)}>
              Download proof
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
