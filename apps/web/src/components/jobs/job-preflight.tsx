'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { PublicKey } from '@solana/web3.js';
import {
  buildPreflightWitness,
  buildSetPreflightProofTx,
  CLOCK_TOLERANCE_SECS,
  createRemoteProver,
  preflightAccepts,
  SIGNAL,
} from '@squaresdk/solana-policy';
import type { JobAccount } from '@squaresdk/solana-sdk';
import type { ProveResponse } from '@squaresdk/solana-types';
import { useActor } from '@/components/actor';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { ENV_VARS } from '@/lib/config';
import { formatDuration, type EscrowSetup } from '@/lib/job-wizard';
import { loadDrafts, loadSecret } from '@/lib/policy-local';
import {
  policyMaterialFor,
  preflightBoundFor,
  proverErrorMessage,
  refusalReasons,
  RELEASE_ARTIFACT_VERSION,
  verifierErrorMessage,
  type PolicyMaterial,
  type PreflightView,
  type ReleaseState,
} from '@/lib/release-proof';
import { sendErrorText } from '@/lib/sponsored-send';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function Reasons({ reasons }: { reasons: readonly string[] }) {
  return (
    <ul className="mt-2 grid list-disc gap-1 pl-5 text-sm">
      {reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  );
}

/**
 * Kabul öncesi uyum ön-ispatı (P-01, ADR 0028): policy'li işte kurum, agent kabul etmeden önce işin kendi
 * koşullarıyla (net = tutar, payee = agent cüzdanı, sayaç 0) kalıcı ya da günlük tavan kuralı çiğnenmediğini
 * kanıtlar; escrow `accept_job`'da bu ön-ispatı ister. Böylece teslimden sonra kalıcı bir ret çıkamaz.
 */
export function JobPreflight({
  escrow,
  jobKey,
  account,
  preflight,
  release,
  chainNow,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  /** İş detayının okuduğu ön-ispat (`readPreflight`). */
  preflight: Load<PreflightView | null>;
  /** Politikanın kurumu ve multisig'i (`readReleaseState`). */
  release: Load<ReleaseState>;
  chainNow: number | null;
}) {
  const institution = useActor('institution').address;
  const status = Object.keys(account.status)[0];
  if (account.policy === null || (status !== 'open' && status !== 'funded')) return null;
  const stored = preflight.state === 'ready' ? preflight.value : null;
  // Kabul yalnızca işin güncel agent cüzdanı için bağlanmış ön-ispatla geçer (ADR 0028).
  const bound = stored && preflightBoundFor(stored, account.agentWallet) ? stored : null;
  const otherWallet = stored !== null && bound === null;
  const isInstitution = Boolean(institution?.equals(account.institution));

  return (
    <section aria-labelledby="preflight-heading" className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="preflight-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Pre-acceptance proof
        </h2>
        {preflight.state === 'ready' && (
          <StatusBadge tone={bound ? 'success' : 'warning'}>
            {bound ? 'Bound' : otherWallet ? 'Bound for another wallet' : 'Missing'}
          </StatusBadge>
        )}
      </div>
      {preflight.state === 'loading' && <p className="mt-3 text-sm text-muted">Reading the preflight proof…</p>}
      {preflight.state === 'error' && (
        <p className="mt-3 text-sm text-danger-text">The preflight proof could not be read: {preflight.message}</p>
      )}
      {preflight.state === 'ready' && (
        <div className="mt-3 grid gap-2 text-sm">
          <p>
            Before the agent accepts, the institution proves that the job&apos;s own terms (the whole amount to the
            agent wallet, with an empty daily counter) break no permanent rule of its policy. After that, a delivered
            job cannot be refused for good; the agent accepts only then.
          </p>
          {bound && (
            <p className="text-muted">
              Bound at <time dateTime={iso(bound.proofTimestamp)}>{iso(bound.proofTimestamp)}</time> (chain time)
              {bound.refusalCode === 0
                ? '; the job satisfies the policy.'
                : `; temporary rules may still hold the release: ${refusalReasons(bound.refusalCode).join('; ')}.`}
            </p>
          )}
          {otherWallet && (
            <p className="rounded-lg bg-tone-warning-bg p-3 text-tone-fg">
              It was bound for the agent wallet <span className="font-mono">{stored.payee.toBase58()}</span>; the job
              has moved to <span className="font-mono">{account.agentWallet.toBase58()}</span> since. The institution
              binds it again for this wallet before the agent can accept.
            </p>
          )}
          {!bound && !isInstitution && <p className="text-muted">Waiting for the institution to bind it.</p>}
        </div>
      )}
      {isInstitution && preflight.state === 'ready' && release.state === 'ready' && (
        <BindPreflight escrow={escrow} jobKey={jobKey} account={account} state={release.value} chainNow={chainNow} />
      )}
    </section>
  );
}

type Proved = { proof: ProveResponse; madeAt: number; refusalCode: number };

function BindPreflight({
  escrow,
  jobKey,
  account,
  state,
  chainNow,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  state: ReleaseState;
  chainNow: number | null;
}) {
  const actor = useActor('institution');
  const { proverUrl } = useWebConfig();
  const guard = useNetworkGuard();
  const categoryId = useId();
  const keyId = useId();
  // Yalnızca kurum adına (cüzdan ya da smart account vault'u, FE-21) çizilir.
  const owner = actor.address!;

  // Politika ve sır FE-04'ün bu tarayıcıdaki çalışma alanından; sunucuya gitmez.
  const [material, setMaterial] = useState<ReturnType<typeof policyMaterialFor> | null>(null);
  useEffect(() => {
    setMaterial(
      policyMaterialFor({
        owner,
        policyProgram: escrow.policyProgram,
        job: account,
        secret: loadSecret(owner.toBase58()),
        drafts: loadDrafts(owner.toBase58()),
      }),
    );
  }, [owner, escrow, account]);

  const [category, setCategory] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [step, setStep] = useState<'idle' | 'proving' | 'binding'>('idle');
  const [proved, setProved] = useState<Proved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const pending =
    signature !== null && status?.stage !== 'confirmed' && status?.stage !== 'finalized' && status?.stage !== 'failed';

  if (state.multisigVault) {
    return (
      <p className="mt-4 border-t border-border pt-4 text-sm text-muted">
        This institution&apos;s authority is its Squads vault ({state.multisigVault.toBase58()}); the proof is bound by
        a vault transaction, not by this wallet.
      </p>
    );
  }
  if (!proverUrl) {
    return (
      <p className="mt-4 border-t border-border pt-4 text-sm text-muted">
        Proofs are made by a prover service, and <span className="font-mono">{ENV_VARS.proverUrl}</span> is not set.
      </p>
    );
  }
  if (!material) return null;
  if (!material.ok) {
    return (
      <p className="mt-4 border-t border-border pt-4 text-sm text-danger-text">
        {material.reason}{' '}
        <Link href="/app/policy" className="text-link underline">
          Policy page
        </Link>
      </p>
    );
  }

  const policy: PolicyMaterial = material.material;
  const chosen = category || policy.categories[0] || '';
  const age = proved && chainNow !== null ? chainNow - proved.madeAt : null;
  // Bağlama anında ispatın anı zincir saatine en fazla 600 s uzak olmalı; gönderim payı için 60 s erken kapanır.
  const expired = age !== null && age > CLOCK_TOLERANCE_SECS - 60;
  const busy = step !== 'idle';
  const confirmed = status?.stage === 'confirmed' || status?.stage === 'finalized';

  const prove = async () => {
    if (chainNow === null) return;
    setError(null);
    setProved(null);
    setSignature(null);
    try {
      setStep('proving');
      const witness = await buildPreflightWitness({
        client: escrow.client,
        job: jobKey,
        policy: policy.document,
        salts: policy.salts,
        paymentCategory: chosen,
        now: chainNow,
      });
      const prover = createRemoteProver({ baseUrl: proverUrl, apiKey, artifactVersion: RELEASE_ARTIFACT_VERSION });
      const proof = await prover.prove(witness);
      setProved({
        proof,
        madeAt: witness.timestamp,
        refusalCode: Number(BigInt(`0x${proof.publicInputs[SIGNAL.refusalCode]!}`)),
      });
    } catch (caught) {
      setError(proverErrorMessage(caught, proverUrl));
    } finally {
      setStep('idle');
    }
  };

  const bind = async () => {
    if (!proved || !account.policy) return;
    setError(null);
    setStep('binding');
    try {
      const built = await buildSetPreflightProofTx(
        escrow.client,
        { authority: owner, institution: state.institution, policy: account.policy, job: jobKey, proof: proved.proof },
        await actor.options(),
      );
      setSignature(await actor.send(built.transaction));
    } catch (caught) {
      setError(sendErrorText(caught, verifierErrorMessage));
    } finally {
      setStep('idle');
    }
  };

  const accepted = proved ? preflightAccepts(proved.refusalCode) : false;
  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Prove the job&apos;s terms</h3>
      <p className="text-sm text-muted">
        The proof is made by the prover at <span className="font-mono">{new URL(proverUrl).host}</span>:{' '}
        <strong className="font-medium text-text">
          whoever runs that prover sees this policy (limits, blocked addresses, categories, salts).
        </strong>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={categoryId} className="text-sm font-medium">
            Payment category
          </label>
          <select
            id={categoryId}
            value={chosen}
            onChange={(event) => setCategory(event.currentTarget.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
            disabled={busy}
          >
            {policy.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={keyId} className="text-sm font-medium">
            Prover API key
          </label>
          <input
            id={keyId}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            aria-describedby={`${keyId}-hint`}
            autoComplete="off"
            className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text"
            disabled={busy}
          />
          <p id={`${keyId}-hint`} className="text-caption text-muted">
            Kept in this page only and sent only to the prover.
          </p>
        </div>
      </div>
      <div>
        <Button
          variant={proved ? 'secondary' : 'primary'}
          onClick={() => void prove()}
          loading={step === 'proving'}
          disabled={apiKey === '' || chainNow === null || busy || pending}
        >
          {proved ? 'Make a new pre-acceptance proof' : 'Make the pre-acceptance proof'}
        </Button>
        {step === 'proving' && <span className="ml-3 text-sm text-muted">Proving…</span>}
      </div>
      {proved && (
        <div className="grid gap-2 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium">
            {proved.refusalCode === 0
              ? "The job's terms satisfy the policy."
              : accepted
                ? 'Only temporary rules refuse the job now; it can still be accepted.'
                : "The job's own terms break the policy: no agent can accept it. Cancel it instead."}
          </p>
          {proved.refusalCode !== 0 && <Reasons reasons={refusalReasons(proved.refusalCode)} />}
          {accepted && (
            <>
              <p className="text-caption text-muted">
                Made at {iso(proved.madeAt)} (chain time).{' '}
                {expired
                  ? 'It is too old to bind now; make a new one.'
                  : `Bind it within ${formatDuration(BigInt(Math.max(0, CLOCK_TOLERANCE_SECS - 60 - (age ?? 0))))}.`}
              </p>
              <div>
                <Button
                  onClick={() => void bind()}
                  loading={step === 'binding'}
                  disabled={expired || !guard.canTransact || busy || pending || confirmed}
                >
                  Bind before acceptance
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {!guard.canTransact && guard.problems.length > 0 && (
        <p className="text-sm text-danger-text">{guard.problems.join(' ')}</p>
      )}
      {error && <p className="text-sm text-danger-text">{error}</p>}
      {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
    </div>
  );
}
