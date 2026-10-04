'use client';

import { useCallback, useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { generatePolicySecret } from '@squaresdk/solana-policy';
import { hexToBytes, newDraft, type PolicyDraft } from './policy-draft';
import { loadDrafts, loadSecret, readBackup, saveDrafts, saveSecret } from './policy-local';

export interface PolicyWorkspace {
  /** Depolama okunana kadar false; sunucu çıktısında sır yoktur. */
  loaded: boolean;
  secret: Uint8Array | null;
  drafts: PolicyDraft[];
  selected: PolicyDraft | null;
  /** Son yazma tarayıcı depolamasına ulaştı mı (gizli pencerede ulaşmaz). */
  stored: boolean;
  createSecret(): void;
  restore(text: string): string | null;
  select(policyId: string): void;
  addPolicy(): void;
  update(draft: PolicyDraft): void;
}

export function usePolicyWorkspace(owner: string): PolicyWorkspace {
  const [state, setState] = useState<{
    owner: string;
    secret: Uint8Array | null;
    drafts: PolicyDraft[];
    selectedId: string | null;
  } | null>(null);
  const [stored, setStored] = useState(true);

  useEffect(() => {
    const drafts = loadDrafts(owner);
    setState({ owner, secret: loadSecret(owner), drafts, selectedId: drafts[0]?.policyId ?? null });
  }, [owner]);

  const current = state?.owner === owner ? state : null;

  const persistDrafts = useCallback(
    (drafts: PolicyDraft[], selectedId: string | null) => {
      setStored(saveDrafts(owner, drafts));
      setState((s) => (s && s.owner === owner ? { ...s, drafts, selectedId } : s));
    },
    [owner],
  );

  const createSecret = useCallback(() => {
    const secret = generatePolicySecret();
    setStored(saveSecret(owner, secret));
    setState((s) => (s && s.owner === owner ? { ...s, secret } : s));
  }, [owner]);

  const restore = useCallback(
    (text: string) => {
      const result = readBackup(text, owner);
      if (!result.ok) return result.error;
      setStored(saveSecret(owner, result.secret) && saveDrafts(owner, result.drafts));
      setState({ owner, secret: result.secret, drafts: result.drafts, selectedId: result.drafts[0]?.policyId ?? null });
      return null;
    },
    [owner],
  );

  const drafts = current?.drafts ?? [];
  const selectedId = current?.selectedId ?? null;

  return {
    loaded: current !== null,
    secret: current?.secret ?? null,
    drafts,
    selected: drafts.find((d) => d.policyId === selectedId) ?? null,
    stored,
    createSecret,
    restore,
    select: (policyId) => setState((s) => (s ? { ...s, selectedId: policyId } : s)),
    addPolicy: () => {
      const draft = newDraft();
      persistDrafts([...drafts, draft], draft.policyId);
    },
    update: (draft) =>
      persistDrafts(
        drafts.map((d) => (d.policyId === draft.policyId ? draft : d)),
        draft.policyId,
      ),
  };
}

export type PolicyAddresses =
  | { state: 'loading' }
  | { state: 'ready'; institution: string; policy: string | null }
  | { state: 'error'; message: string };

/** Institution ve Policy PDA'ları. Seed'ler SDK'nın IDL'inden okunur; Anchor yalnızca bu sayfada yüklenir. */
export function usePolicyAddresses(policyProgramId: string, owner: string, policyId: string | null): PolicyAddresses {
  const [addresses, setAddresses] = useState<PolicyAddresses>({ state: 'loading' });

  useEffect(() => {
    let active = true;
    import('./idl-pda').then(
      ({ institutionAddress, policyAddress }) => {
        if (!active) return;
        const program = new PublicKey(policyProgramId);
        const institution = institutionAddress(program, new PublicKey(owner));
        setAddresses({
          state: 'ready',
          institution: institution.toBase58(),
          policy: policyId ? policyAddress(program, institution, hexToBytes(policyId)).toBase58() : null,
        });
      },
      (error: Error) => active && setAddresses({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [policyProgramId, owner, policyId]);

  return addresses;
}
