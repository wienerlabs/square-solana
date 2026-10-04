'use client';

import { useMemo } from 'react';
import { useWebConfig } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { checkDraft, draftDocument } from '@/lib/policy-draft';
import { usePolicyAddresses, usePolicyWorkspace } from '@/lib/use-policy-workspace';
import { useSettlementToken } from '@/lib/use-settlement';
import { OnChainPreview } from './onchain-preview';
import { PolicyForm } from './policy-form';
import { SecretPanel } from './secret-panel';

/** Bağlı kurum cüzdanının politikaları. `owner` kurumun yetkili cüzdanı, `policyProgramId` square_policy. */
export function InstitutionPolicies({ owner, policyProgramId }: { owner: string; policyProgramId: string }) {
  const { cluster, programIds } = useWebConfig();
  const workspace = usePolicyWorkspace(owner);
  const settlementState = useSettlementToken(programIds.escrow);
  const settlement = settlementState.state === 'ready' ? settlementState.token : null;
  const draft = workspace.selected;
  const addresses = usePolicyAddresses(policyProgramId, owner, draft?.policyId ?? null);

  const check = useMemo(
    () => (draft ? checkDraft(draft, settlement?.mint.toBase58() ?? null) : null),
    [draft, settlement],
  );
  // Alıcı listesi belgeye girmez; yalnızca kökü etkiler.
  const rulesValid = check !== null && Object.keys(check.errors).every((field) => field === 'buyers');
  const document = useMemo(
    () => (draft && rulesValid && addresses.state === 'ready' ? draftDocument(draft, addresses.institution) : null),
    [draft, rulesValid, addresses],
  );

  if (!workspace.loaded) return null;

  return (
    <div className="grid gap-6">
      <SecretPanel owner={owner} cluster={cluster} workspace={workspace} />
      {workspace.secret && (
        <section aria-labelledby="policies-heading" className="rounded-card border border-border bg-surface p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="policies-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
              Policies
            </h2>
            <Button size="sm" variant="secondary" onClick={workspace.addPolicy}>
              New policy
            </Button>
          </div>
          {workspace.drafts.length === 0 && (
            <p className="mt-3 text-sm text-muted">No policy yet. Start one to write its rules.</p>
          )}
          {workspace.drafts.length > 1 && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              Editing
              <select
                value={draft?.policyId}
                onChange={(event) => workspace.select(event.currentTarget.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1 font-mono text-caption"
              >
                {workspace.drafts.map((d) => (
                  <option key={d.policyId} value={d.policyId}>
                    {d.policyId.slice(0, 8)}…{d.policyId.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft && check && (
            <div className="mt-5">
              <PolicyForm
                key={`${draft.policyId}:${settlement?.decimals ?? 'base'}`}
                draft={draft}
                check={check}
                settlement={settlement}
                onChange={workspace.update}
              />
            </div>
          )}
        </section>
      )}
      {workspace.secret && draft && check && (
        <OnChainPreview
          cluster={cluster}
          addresses={addresses}
          draft={draft}
          document={document}
          buyersValid={!check.errors.buyers}
          secret={workspace.secret}
        />
      )}
    </div>
  );
}
