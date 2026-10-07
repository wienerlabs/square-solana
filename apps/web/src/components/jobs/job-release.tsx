'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { PublicKey } from '@solana/web3.js';
import {
  buildReleaseWitness,
  buildSetComplianceProofTx,
  CLOCK_TOLERANCE_SECS,
  createRemoteProver,
  isFinalRefusal,
  SIGNAL,
} from '@squaresdk/solana-policy';
import type { ClaimListingAccount, JobAccount } from '@squaresdk/solana-sdk';
import type { ProveResponse } from '@squaresdk/solana-types';
import { useActor } from '@/components/actor';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { formatDuration, type EscrowSetup } from '@/lib/job-wizard';
import { loadDrafts, loadSecret } from '@/lib/policy-local';
import {
  policyMaterialFor,
  proverErrorMessage,
  refusalReasons,
  RELEASE_ARTIFACT_VERSION,
  releaseOutlook,
  verifierErrorMessage,
  type PolicyMaterial,
  type ReleaseOutlook,
  type ReleaseState,
} from '@/lib/release-proof';
import { sendErrorText } from '@/lib/sponsored-send';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const DAY = 86_400;

const OUTLOOK: Readonly<Record<ReleaseOutlook['kind'], { tone: Tone; badge: string }>> = {
  noProof: { tone: 'warning', badge: 'No proof' },
  pays: { tone: 'success', badge: 'Compliant' },
  refunds: { tone: 'danger', badge: 'Refused' },
  waits: { tone: 'warning', badge: 'Refused for now' },
  stale: { tone: 'warning', badge: 'Stale' },
  consumed: { tone: 'neutral', badge: 'Used' },
};

function ProofRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

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
 * Uyum ispatı ve release durumu (FE-09): politikaya bağlı işte `ReleaseProof`, tazeliği ve escrow'un
 * finalize'da ne yapacağı herkese açık; işi fonlayan kurum ispatı prover servisinde üretip bağlar.
 */
export function JobRelease({
  escrow,
  jobKey,
  account,
  listing,
  release: state,
  chainNow,
  formatAmount,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  listing: ClaimListingAccount | null;
  /** İş detayının okuduğu ispat durumu (`readReleaseState`); finalize paneliyle ortak. */
  release: Load<ReleaseState>;
  chainNow: number | null;
  formatAmount(base: bigint): string;
}) {
  const institution = useActor('institution').address;
  if (account.policy === null) return null;
  const status = Object.keys(account.status)[0];
  const bindable = status === 'delivered' || status === 'disputed';
  const outlook =
    state.state === 'ready' && chainNow !== null ? releaseOutlook(state.value, account, listing, chainNow) : null;
  const proof = state.state === 'ready' ? state.value.proof : null;
  const isInstitution = Boolean(institution?.equals(account.institution));

  return (
    <section aria-labelledby="release-heading" className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="release-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Compliance proof
        </h2>
        {outlook && <StatusBadge tone={OUTLOOK[outlook.kind].tone}>{OUTLOOK[outlook.kind].badge}</StatusBadge>}
      </div>
      {state.state === 'loading' && <p className="mt-3 text-sm text-muted">Reading the release proof…</p>}
      {state.state === 'error' && (
        <p className="mt-3 text-sm text-danger-text">The release proof could not be read: {state.message}</p>
      )}
      {outlook && (
        <div className="mt-3 text-sm">
          {outlook.kind === 'noProof' && (
            <p>
              The job is paid only against the institution&apos;s compliance proof. Until one is bound, finalize waits
              (ProofRequired).
            </p>
          )}
          {outlook.kind === 'pays' && (
            <p>
              The proof is fresh and compliant: once the challenge window closes, anyone can finalize and{' '}
              {formatAmount(outlook.proof.netAmount)} goes to the payee.
            </p>
          )}
          {outlook.kind === 'refunds' && (
            <>
              <p>
                The institution&apos;s policy refuses this release for good: finalize refunds{' '}
                {formatAmount(outlook.proof.netAmount)} to the institution.
              </p>
              <Reasons reasons={outlook.reasons} />
            </>
          )}
          {outlook.kind === 'waits' && (
            <>
              <p>
                The policy refuses this release for now, so finalize waits (ProofRequired). A compliant proof bound
                later is paid.
              </p>
              <Reasons reasons={outlook.reasons} />
            </>
          )}
          {outlook.kind === 'stale' && (
            <>
              <p>Finalize waits (StaleReleaseProof) until the institution binds a fresh proof:</p>
              <Reasons reasons={outlook.reasons} />
            </>
          )}
          {outlook.kind === 'consumed' && (
            <p>
              The release used this proof:{' '}
              {outlook.proof.compliant
                ? 'the payee was paid.'
                : `the institution was refunded (${refusalReasons(outlook.proof.refusalCode).join('; ')}).`}
            </p>
          )}
        </div>
      )}
      {proof && chainNow !== null && (
        <dl className="mt-4 grid gap-2 text-sm">
          <ProofRow label="Verdict">{proof.compliant ? 'Compliant' : `Refused (code ${proof.refusalCode})`}</ProofRow>
          <ProofRow label="Made">
            <time dateTime={iso(proof.proofTimestamp)}>{iso(proof.proofTimestamp)}</time>
            <span className="text-caption text-muted">
              {formatDuration(BigInt(Math.max(0, chainNow - proof.proofTimestamp)))} ago, chain time
            </span>
          </ProofRow>
          {!proof.consumed && outlook?.kind !== 'stale' && (
            <ProofRow label="Fresh until">
              <time dateTime={iso((Math.floor(proof.proofTimestamp / DAY) + 1) * DAY)}>
                {iso((Math.floor(proof.proofTimestamp / DAY) + 1) * DAY)}
              </time>
              <span className="text-caption text-muted">
                the end of its UTC day, if no other release moves the counter
              </span>
            </ProofRow>
          )}
          <ProofRow label="Payee">
            <Address value={proof.payee.toBase58()} label="payee" />
          </ProofRow>
          <ProofRow label="Net">
            <span className="font-mono">{formatAmount(proof.netAmount)}</span>
          </ProofRow>
          <ProofRow label="Daily counter before">
            <span className="font-mono">{formatAmount(proof.dailySpentBefore)}</span>
          </ProofRow>
        </dl>
      )}
      {isInstitution && bindable && state.state === 'ready' && !state.value.proof?.consumed && (
        <BindProof
          escrow={escrow}
          jobKey={jobKey}
          account={account}
          state={state.value}
          chainNow={chainNow}
          formatAmount={formatAmount}
        />
      )}
    </section>
  );
}

type Proved = { proof: ProveResponse; madeAt: number; refusalCode: number; dailySpentBefore: bigint };

function BindProof({
  escrow,
  jobKey,
  account,
  state,
  chainNow,
  formatAmount,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  state: ReleaseState;
  chainNow: number | null;
  formatAmount(base: bigint): string;
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
  const [step, setStep] = useState<'idle' | 'witness' | 'proving' | 'binding'>('idle');
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
        Proofs are made by a prover service, and <span className="font-mono">SQUARE_PROVER_URL</span> is not set.
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

  const prove = async () => {
    if (chainNow === null) return;
    setError(null);
    setProved(null);
    setSignature(null);
    try {
      setStep('witness');
      const witness = await buildReleaseWitness({
        client: escrow.client,
        job: jobKey,
        policy: policy.document,
        salts: policy.salts,
        paymentCategory: chosen,
        now: chainNow,
      });
      setStep('proving');
      const prover = createRemoteProver({ baseUrl: proverUrl, apiKey, artifactVersion: RELEASE_ARTIFACT_VERSION });
      const proof = await prover.prove(witness);
      setProved({
        proof,
        madeAt: witness.timestamp,
        refusalCode: Number(BigInt(`0x${proof.publicInputs[SIGNAL.refusalCode]!}`)),
        dailySpentBefore: witness.dailySpentBefore,
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
      const built = await buildSetComplianceProofTx(
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

  const busy = step !== 'idle';
  const reasons = proved ? refusalReasons(proved.refusalCode) : [];
  const confirmed = status?.stage === 'confirmed' || status?.stage === 'finalized';

  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Prove this release</h3>
      <p className="text-sm text-muted">
        The proof shows, without revealing the policy, whether this release satisfies it. It is made by the prover at{' '}
        <span className="font-mono">{new URL(proverUrl).host}</span>:{' '}
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
          loading={step === 'witness' || step === 'proving'}
          disabled={apiKey === '' || chainNow === null || busy || pending}
        >
          {proved ? 'Make a new proof' : 'Make a proof'}
        </Button>
        {step === 'witness' && <span className="ml-3 text-sm text-muted">Reading the release from the chain…</span>}
        {step === 'proving' && <span className="ml-3 text-sm text-muted">Proving…</span>}
      </div>
      {proved && (
        <div className="grid gap-2 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium">
            {proved.refusalCode === 0
              ? 'The release satisfies the policy.'
              : isFinalRefusal(proved.refusalCode, proved.dailySpentBefore)
                ? 'The policy refuses this release: binding this proof makes finalize refund the institution.'
                : 'The policy refuses this release for now: binding this proof keeps the escrow waiting.'}
          </p>
          {reasons.length > 0 && <Reasons reasons={reasons} />}
          <p className="text-caption text-muted">
            Net {formatAmount(BigInt(`0x${proved.proof.publicInputs[SIGNAL.netAmount]!}`))}, made at{' '}
            {iso(proved.madeAt)} (chain time) in {(proved.proof.provingMs / 1000).toFixed(1)} s.{' '}
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
              Bind on chain
            </Button>
          </div>
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
