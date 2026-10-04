'use client';

import { useMemo } from 'react';
import { PublicKey } from '@solana/web3.js';
import { buildBuyerTree, computePolicyCommitment, derivePolicySalts } from '@squaresdk/solana-policy';
import type { PolicyDocument } from '@squaresdk/solana-types';
import { Address } from '@/components/ui/address';
import { bytesToHex, hexToBytes, type PolicyDraft } from '@/lib/policy-draft';
import type { PolicyAddresses } from '@/lib/use-policy-workspace';

function Hex({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="sr-only">{label}</span>
      <code className="break-all font-mono text-caption">{value}</code>
    </span>
  );
}

interface Props {
  cluster: string;
  addresses: PolicyAddresses;
  draft: PolicyDraft;
  document: PolicyDocument | null;
  buyersValid: boolean;
  secret: Uint8Array;
}

/** Zincire giden üç değer bu tarayıcıda hesaplanır: commitment, public tavan ve alıcı kökü. */
export function OnChainPreview({ cluster, addresses, draft, document, buyersValid, secret }: Props) {
  const commitment = useMemo(
    () =>
      document
        ? bytesToHex(computePolicyCommitment(document, derivePolicySalts(secret, hexToBytes(draft.policyId))))
        : null,
    [document, secret, draft.policyId],
  );
  const buyerRoot = useMemo(
    () =>
      buyersValid
        ? bytesToHex(
            buildBuyerTree(
              draft.buyers.map((b) => ({ buyer: new PublicKey(b.buyer), leafSalt: hexToBytes(b.leafSalt) })),
            ).root,
          )
        : null,
    [buyersValid, draft.buyers],
  );

  return (
    <section aria-labelledby="onchain-heading" className="rounded-card border border-border bg-surface p-6">
      <h2 id="onchain-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
        What goes on chain
      </h2>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted">Institution</dt>
        <dd>
          {addresses.state === 'ready' && <Address value={addresses.institution} />}
          {addresses.state === 'loading' && '…'}
          {addresses.state === 'error' && <span className="text-danger-text">{addresses.message}</span>}
        </dd>
        <dt className="text-muted">Policy account</dt>
        <dd>{addresses.state === 'ready' && addresses.policy && <Address value={addresses.policy} />}</dd>
        <dt className="text-muted">policy_id</dt>
        <dd>
          <Hex value={draft.policyId} label="Policy id" />
        </dd>
        <dt className="text-muted">commitment</dt>
        <dd>
          {commitment ? (
            <Hex value={commitment} label="Policy commitment" />
          ) : (
            <span className="text-muted">Complete the rules to compute the commitment.</span>
          )}
        </dd>
        <dt className="text-muted">daily_ceiling</dt>
        <dd className="font-mono">{document ? document.dailyCeiling : '—'}</dd>
        <dt className="text-muted">buyer_root</dt>
        <dd>
          {buyerRoot ? (
            <>
              <Hex value={buyerRoot} label="Buyer root" />
              {draft.buyers.length === 0 && (
                <span className="text-caption text-muted">Empty list: the zero root lets any buyer buy.</span>
              )}
            </>
          ) : (
            <span className="text-muted">Fix the buyer list to compute the root.</span>
          )}
        </dd>
      </dl>
      <p className="mt-4 text-sm text-muted">
        Everything else stays in this browser: both private limits, the three lists, the categories, the time window,
        the secret and its salts. Committing on chain becomes available once square_policy with set_policy and
        set_buyer_root is deployed on {cluster}.
      </p>
      <p className="mt-2 text-sm text-muted">
        Release proofs are built later by the institution&apos;s software from this policy and the secret. A local
        prover keeps them on that machine; a remote prover receives the policy and its salts, so use one only if you
        trust its operator.
      </p>
    </section>
  );
}
