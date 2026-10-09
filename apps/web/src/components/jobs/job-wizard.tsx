'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import type { FiatConfig } from '@squaresdk/solana-types';
import { useApiClient } from '@/components/api-client';
import { useActor } from '@/components/actor';
import { useNetworkGuard } from '@/components/network-guard';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { JobTravelRule } from './job-travel-rule';
import { chainRefOf, hex } from '@/lib/agent-registration';
import { fiatAmount, fiatPaymentErrorText, formatUsd } from '@/lib/fiat';
import { institutionAddress, policyAddress } from '@/lib/idl-pda';
import {
  escrowErrorMessage,
  formatDuration,
  parseAgentRef,
  parseChallengePeriod,
  parseDeadline,
  parseSpec,
  readAgent,
  readEscrowSetup,
  readScreening,
  SCREENING_TEXT,
  screeningBlock,
  type AgentSummary,
  type EscrowSetupLookup,
  type ScreeningState,
} from '@/lib/job-wizard';
import { readPolicyChain } from '@/lib/policy-chain';
import { hexToBytes } from '@/lib/policy-draft';
import { loadDrafts } from '@/lib/policy-local';
import { sendErrorText } from '@/lib/sponsored-send';
import { formatUnits, parseUnits, settlementAccount } from '@/lib/settlement';
import { unwrap } from '@/lib/square-api';
import { statusLabel } from '@/lib/status';
import { isBound, travelRuleFundBlock, travelRuleRequired, type TravelRuleVerification } from '@/lib/travel-rule';
import { useSettlementToken, useTokenBalance } from '@/lib/use-settlement';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text aria-invalid:border-danger-text';
const SCREENING_TONE: Readonly<Record<ScreeningState['state'], Tone>> = {
  clear: 'success',
  missing: 'warning',
  expired: 'warning',
  flagged: 'danger',
};

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p id={`${id}-hint`} className="text-caption text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-caption text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-card border border-border bg-surface p-6">
      <h2 id={id} className="text-sm font-medium uppercase tracking-wide text-muted">
        {title}
      </h2>
      <div className="mt-4 grid gap-5">{children}</div>
    </section>
  );
}

const NO_COMMITMENT = new Uint8Array(32);

type Rail = 'escrow' | 'fiat';

interface WizardJob {
  status: string;
  rail: Rail;
  amount: bigint;
  mint: PublicKey;
  agentWallet: PublicKey;
  /** `Job.travel_rule_commitment`; sıfır: bağlı değil. */
  commitment: Uint8Array;
}

interface ActivePolicy {
  address: string;
  dailyCeiling: bigint;
  version: number;
}

/**
 * Kurumun iş açması ve fonlaması: `create_job` + `fund_job` (akışın 3. adımı). Kurum cüzdan ya da smart account'un
 * vault'udur (FE-21); fonlama vault'un USDC hesabından. Fiat rayında (FE-20, ADR 0024) `create_fiat_job`: vault,
 * fonlama, challenge penceresi ve Travel Rule commitment'ı yoktur; iş bir politikaya bağlıdır, iki tarafın screening'i
 * açılışta okunur ve kurum teslimden sonra iş sayfasında kartla öder.
 */
export function JobWizard({ owner, escrowProgramId }: { owner: string; escrowProgramId: string }) {
  const { connection } = useConnection();
  const guard = useNetworkGuard();
  const actor = useActor('institution');
  const ownerKey = useMemo(() => new PublicKey(owner), [owner]);
  const verified = guard.rpc.state === 'ready' && !guard.rpc.mismatch;
  const genesisHash = guard.rpc.state === 'ready' ? guard.rpc.genesisHash : null;
  // Settlement mint'i de escrow config'inden; ağ doğrulanmadan okunmaz.
  const settlementState = useSettlementToken(verified ? escrowProgramId : undefined);
  const token = settlementState.state === 'ready' ? settlementState.token : null;

  const [setupLoad, setSetupLoad] = useState<Load<EscrowSetupLookup>>({ state: 'loading' });
  useEffect(() => {
    if (!verified) return;
    let active = true;
    readEscrowSetup(connection, new PublicKey(escrowProgramId)).then(
      (value) => active && setSetupLoad({ state: 'ready', value }),
      (error: Error) => active && setSetupLoad({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [verified, connection, escrowProgramId]);
  const setup = setupLoad.state === 'ready' && setupLoad.value.state === 'ready' ? setupLoad.value.setup : null;

  const [agentText, setAgentText] = useState('');
  const [amountText, setAmountText] = useState('');
  const [deadlineText, setDeadlineText] = useState('');
  const [challengeText, setChallengeText] = useState('');
  const [policyChoice, setPolicyChoice] = useState('');
  const [railChoice, setRailChoice] = useState<Rail>('escrow');
  const railHintId = useId();
  const [specText, setSpecText] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Agent: DID ya da kayıt adresi; kayıt zincirden okunur.
  const agentRef =
    setup && genesisHash
      ? parseAgentRef(agentText, { chainRef: chainRefOf(genesisHash), registryProgram: setup.registryProgram })
      : null;
  const agentRecord = agentRef?.ok ? agentRef.agentRecord.toBase58() : null;
  const [agent, setAgent] = useState<Load<AgentSummary | null> | null>(null);
  useEffect(() => {
    if (!setup || !agentRecord) {
      setAgent(null);
      return;
    }
    let active = true;
    setAgent({ state: 'loading' });
    readAgent(setup, new PublicKey(agentRecord)).then(
      (value) => active && setAgent({ state: 'ready', value }),
      (error: Error) => active && setAgent({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [setup, agentRecord]);
  const agentSummary = agent?.state === 'ready' ? agent.value : null;

  // Bağlanabilecek politikalar: bu tarayıcıdaki taslaklardan zincirde etkin olanlar (FE-04).
  const [policies, setPolicies] = useState<Load<ActivePolicy[]>>({ state: 'loading' });
  useEffect(() => {
    if (!setup) return;
    let active = true;
    const drafts = loadDrafts(owner);
    Promise.all(
      drafts.map(async (draft) => {
        const policyId = hexToBytes(draft.policyId);
        const chain = await readPolicyChain(connection, setup.policyProgram, ownerKey, policyId);
        if (!chain.policy?.active) return null;
        const address = policyAddress(setup.policyProgram, institutionAddress(setup.policyProgram, ownerKey), policyId);
        return { address: address.toBase58(), dailyCeiling: chain.policy.dailyCeiling, version: chain.policy.version };
      }),
    ).then(
      (list) => active && setPolicies({ state: 'ready', value: list.filter((p): p is ActivePolicy => p !== null) }),
      (error: Error) => active && setPolicies({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [setup, connection, owner, ownerKey]);
  const policy = policies.state === 'ready' ? (policies.value.find((p) => p.address === policyChoice) ?? null) : null;

  const amount = token ? parseUnits(amountText, token.decimals) : null;
  const amountError = amountText === '' ? null : amount && !amount.ok ? amount.error : null;
  const amountValue = amount?.ok && amount.value > 0n ? amount.value : null;
  const deadline = parseDeadline(deadlineText, now);
  const challenge = setup
    ? parseChallengePeriod(challengeText, { min: setup.minChallengePeriod, max: setup.maxChallengePeriod })
    : null;
  const spec = parseSpec(specText);

  const jobAddress = setup && spec.ok ? setup.client.pda.job(ownerKey, spec.hash)[0].toBase58() : null;
  const [refresh, setRefresh] = useState(0);
  const [job, setJob] = useState<Load<WizardJob | null> | null>(null);
  useEffect(() => {
    if (!setup || !jobAddress) {
      setJob(null);
      return;
    }
    let active = true;
    setJob({ state: 'loading' });
    setup.client.escrow.fetch('job', new PublicKey(jobAddress)).then(
      (value) =>
        active &&
        setJob({
          state: 'ready',
          value: value && {
            status: Object.keys(value.status)[0]!,
            rail: 'fiat' in value.rail ? 'fiat' : 'escrow',
            amount: BigInt(value.amount.toString()),
            mint: value.mint,
            agentWallet: value.agentWallet,
            commitment: Uint8Array.from(value.travelRuleCommitment),
          },
        }),
      (error: Error) => active && setJob({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [setup, jobAddress, refresh]);
  const existingJob = job?.state === 'ready' ? job.value : null;
  // Var olan işin rayı zincirdendir; yeni işte seçim.
  const rail: Rail = existingJob?.rail ?? railChoice;
  const fiat = rail === 'fiat';

  // Screening: kurum ve job'un (yoksa agent kaydının) cüzdanı; fonlama ikisini de ister.
  const agentWallet = existingJob?.agentWallet.toBase58() ?? agentSummary?.wallet.toBase58() ?? null;
  const [screening, setScreening] = useState<Load<{ institution: ScreeningState; agent: ScreeningState }> | null>(null);
  useEffect(() => {
    if (!setup || !agentWallet) {
      setScreening(null);
      return;
    }
    let active = true;
    setScreening({ state: 'loading' });
    Promise.all([readScreening(setup, ownerKey, now), readScreening(setup, new PublicKey(agentWallet), now)]).then(
      ([institution, agentState]) =>
        active && setScreening({ state: 'ready', value: { institution, agent: agentState } }),
      (error: Error) => active && setScreening({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [setup, ownerKey, agentWallet, now, refresh]);
  const fundBlock =
    screening?.state === 'ready' ? screeningBlock(screening.value.institution, screening.value.agent) : null;

  const balanceState = useTokenBalance(ownerKey, token);
  const balance = balanceState.state === 'ready' ? balanceState : null;
  const fundAmount = existingJob?.amount ?? amountValue;
  const insufficient =
    fundAmount !== null && balance !== null && (balance.amount === null || balance.amount < fundAmount);
  // Travel Rule commitment'ı fonlama transferine bağlanır; fiat işte zincirde fonlama yoktur (ADR 0024).
  const travelRule =
    !fiat && setup !== null && fundAmount !== null && travelRuleRequired(fundAmount, setup.travelRuleThreshold);

  const apiClient = useApiClient(actor.api);
  const { publicApi } = apiClient;
  // Kartla ödeme: Square API'sinin fiat rayı (yayımlanabilir anahtar, en düşük tutar); yapılandırılmamışsa seçilemez.
  const [fiatConfig, setFiatConfig] = useState<Load<FiatConfig> | null>(null);
  useEffect(() => {
    if (!publicApi) {
      setFiatConfig(null);
      return;
    }
    let active = true;
    setFiatConfig({ state: 'loading' });
    const failed = (caught: unknown) =>
      active && setFiatConfig({ state: 'error', message: fiatPaymentErrorText(caught) });
    publicApi.getFiatConfig().then((envelope) => {
      if (!active) return;
      try {
        setFiatConfig({ state: 'ready', value: unwrap(envelope) });
      } catch (caught) {
        failed(caught);
      }
    }, failed);
    return () => {
      active = false;
    };
  }, [publicApi]);
  const fiatUnavailable =
    fiatConfig === null
      ? 'Card payments go through the Square API, which is not configured here.'
      : fiatConfig.state === 'error'
        ? fiatConfig.message
        : fiatConfig.state === 'loading'
          ? 'Reading the card payment settings…'
          : null;
  const cardAmount =
    fiat && token && amountValue !== null && fiatConfig?.state === 'ready'
      ? fiatAmount(amountValue, token.decimals, fiatConfig.value)
      : null;
  const [travelVerification, setTravelVerification] = useState<TravelRuleVerification | null>(null);
  const chainCommitment = existingJob?.commitment ?? NO_COMMITMENT;
  const travelBlock = travelRuleFundBlock({
    required: travelRule,
    chainCommitment,
    verification: travelVerification,
  });
  const onTravelRuleConfirmed = useCallback(() => setRefresh((n) => n + 1), []);

  const [busy, setBusy] = useState<'create' | 'fund' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const confirmed = status?.stage === 'confirmed' || status?.stage === 'finalized';
  useEffect(() => {
    if (confirmed) setRefresh((n) => n + 1);
  }, [confirmed]);
  const pending = signature !== null && !confirmed && status?.stage !== 'failed';

  const canCreate =
    setup !== null &&
    !existingJob &&
    agentSummary?.status === 'active' &&
    amountValue !== null &&
    deadline.ok &&
    spec.ok &&
    (policyChoice === '' || policy !== null) &&
    // Public tavanı aşan iş açılmaz (ADR 0028): escrow ve fiat `AmountAboveDailyCeiling` döner.
    !(policy && amountValue !== null && amountValue > policy.dailyCeiling) &&
    guard.canTransact &&
    !pending &&
    (fiat
      ? // Fiat iş politikasız açılmaz; iki tarafın screening'i açılışta denetlenir (`create_fiat_job`).
        policy !== null && cardAmount?.ok === true && screening?.state === 'ready' && fundBlock === null
      : challenge?.ok === true);
  const canFund =
    setup !== null &&
    token !== null &&
    existingJob?.status === 'open' &&
    screening?.state === 'ready' &&
    fundBlock === null &&
    !insufficient &&
    travelBlock === null &&
    guard.canTransact &&
    !pending;

  const run = async (kind: 'create' | 'fund') => {
    if (!setup || !token || !spec.ok) return;
    setBusy(kind);
    setError(null);
    try {
      const options = await actor.options();
      const built =
        kind === 'create' && fiat
          ? await setup.client.flow.createFiatJob(
              {
                institution: ownerKey,
                agentRecord: new PublicKey(agentRecord!),
                policy: new PublicKey(policy!.address),
                spec: spec.spec,
                amount: amountValue!,
                deadline: deadline.ok ? deadline.unix : 0,
              },
              options,
            )
          : kind === 'create'
            ? await setup.client.flow.createJob(
                {
                  institution: ownerKey,
                  agentRecord: new PublicKey(agentRecord!),
                  ...(policy && { policy: new PublicKey(policy.address) }),
                  spec: spec.spec,
                  amount: amountValue!,
                  deadline: deadline.ok ? deadline.unix : 0,
                  challengePeriod: challenge?.ok ? challenge.seconds : 0n,
                },
                options,
              )
            : await setup.client.flow.fundJob(
                {
                  institution: ownerKey,
                  job: new PublicKey(jobAddress!),
                  institutionTokenAccount: settlementAccount(ownerKey, token),
                },
                options,
              );
      setSignature(await actor.send(built.transaction));
    } catch (err) {
      setError(sendErrorText(err, escrowErrorMessage));
    } finally {
      setBusy(null);
    }
  };

  if (!verified) {
    return (
      <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">
        {guard.rpc.state === 'checking'
          ? 'Verifying the network before reading the escrow…'
          : 'The network is not verified, so the escrow is not read and no job can be opened.'}
      </p>
    );
  }
  if (setupLoad.state === 'loading') return <p className="text-sm text-muted">Reading the escrow config…</p>;
  if (setupLoad.state === 'error')
    return <p className="text-sm text-danger-text">The escrow config could not be read: {setupLoad.message}</p>;
  if (setupLoad.value.state === 'uninitialized') {
    return (
      <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">
        The escrow is not initialized on this network yet (no config at{' '}
        <span className="font-mono">{setupLoad.value.config.toBase58()}</span>).
      </p>
    );
  }

  return (
    <div className="grid gap-6">
      <Section id="job-agent" title="Agent">
        <Field
          label="Agent DID or record address"
          hint="The agent's did:aip identity, as shown on its profile, or its agent record address."
          error={agentText === '' ? null : agentRef && !agentRef.ok ? agentRef.error : null}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={inputClass}
              value={agentText}
              onChange={(event) => setAgentText(event.target.value.trim())}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              spellCheck={false}
              disabled={existingJob !== null}
            />
          )}
        </Field>
        {agent?.state === 'loading' && <p className="text-sm text-muted">Reading the agent record…</p>}
        {agent?.state === 'error' && <p className="text-sm text-danger-text">{agent.message}</p>}
        {agent?.state === 'ready' && !agentSummary && (
          <p className="text-sm text-danger-text">No agent record of this registry exists at that address.</p>
        )}
        {agentSummary && (
          <dl className="grid gap-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted">Agent</dt>
              <dd className="flex items-center gap-2">
                <span className="font-mono">{agentSummary.agentId}</span>
                <StatusBadge tone={agentSummary.status === 'active' ? 'success' : 'warning'}>
                  {statusLabel(agentSummary.status)}
                </StatusBadge>
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted">Paid to</dt>
              <dd>
                <Address value={agentSummary.wallet.toBase58()} label="agent wallet" />
              </dd>
            </div>
            {agentSummary.status !== 'active' && (
              <p className="text-danger-text">Only an active agent can take a job.</p>
            )}
          </dl>
        )}
      </Section>

      <Section id="job-terms" title="Terms">
        <fieldset className="grid gap-2" aria-describedby={railHintId}>
          <legend className="text-sm font-medium">Settlement</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="job-rail"
              className="mt-1"
              checked={rail === 'escrow'}
              onChange={() => setRailChoice('escrow')}
              disabled={existingJob !== null}
            />
            <span>
              USDC escrow: the amount is locked in the job&apos;s vault when funded and released by the escrow.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="job-rail"
              className="mt-1"
              checked={rail === 'fiat'}
              onChange={() => setRailChoice('fiat')}
              disabled={existingJob !== null || (fiatUnavailable !== null && rail !== 'fiat')}
            />
            <span>
              Card in USD (Stripe): no vault and no funding; the institution pays by card once the agent delivers, and
              the payment goes to Square&apos;s Stripe account. The job needs a policy.
            </span>
          </label>
          <p id={railHintId} className="text-caption text-muted">
            {fiatUnavailable && !existingJob
              ? `Card payments: ${fiatUnavailable}`
              : 'A card-paid job has no challenge window, dispute or receivable sale: the payment accepts the delivery.'}
          </p>
        </fieldset>
        <Field
          label={fiat ? 'Amount (USD)' : 'Amount (USDC)'}
          hint={
            !token
              ? 'The settlement mint is read from the escrow config.'
              : fiat
                ? `Paid by card in USD, ${token.decimals} decimals like the settlement mint: whole cents${
                    fiatConfig?.state === 'ready'
                      ? `, at least ${formatUsd(fiatConfig.value.minimumAmountMinor)} (Stripe's minimum)`
                      : ''
                  }.`
                : `Locked in the job's vault when funded. ${token.decimals} decimals.`
          }
          error={amountError ?? (cardAmount && !cardAmount.ok ? cardAmount.reason : null)}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={inputClass}
              value={amountText}
              onChange={(event) => setAmountText(event.target.value.trim())}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              inputMode="decimal"
              autoComplete="off"
              disabled={existingJob !== null || !token}
            />
          )}
        </Field>
        <Field
          label="Deadline"
          hint="Your local time. The agent must deliver before it; after it an unaccepted job can be cancelled."
          error={deadlineText === '' ? null : deadline.ok ? null : deadline.error}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="datetime-local"
              className={inputClass}
              value={deadlineText}
              onChange={(event) => setDeadlineText(event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={existingJob !== null}
            />
          )}
        </Field>
        {!fiat && (
          <Field
            label="Challenge period (minutes)"
            hint={`How long you can dispute the delivery before it is paid: ${formatDuration(setupLoad.value.setup.minChallengePeriod)} to ${formatDuration(setupLoad.value.setup.maxChallengePeriod)}.`}
            error={challengeText === '' ? null : challenge && !challenge.ok ? challenge.error : null}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className={inputClass}
                value={challengeText}
                onChange={(event) => setChallengeText(event.target.value.trim())}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                inputMode="numeric"
                autoComplete="off"
                disabled={existingJob !== null}
              />
            )}
          </Field>
        )}
        <Field
          label="Spending policy"
          hint="A bound policy makes the release proof-gated: payment needs a compliance proof against this policy's commitment. Lists the active policies committed from this browser."
          error={policies.state === 'error' ? `The policies could not be read: ${policies.message}` : null}
        >
          {({ id, describedBy }) => (
            <select
              id={id}
              className={inputClass}
              value={policyChoice}
              onChange={(event) => setPolicyChoice(event.target.value)}
              aria-describedby={describedBy}
              disabled={existingJob !== null}
            >
              <option value="">
                {fiat ? 'Choose a policy (required for card payments)' : 'No policy (no proof gate)'}
              </option>
              {policies.state === 'ready' &&
                policies.value.map((p) => (
                  <option key={p.address} value={p.address}>
                    {p.address.slice(0, 4)}…{p.address.slice(-4)} · version {p.version} · ceiling{' '}
                    {token ? formatUnits(p.dailyCeiling, token.decimals) : p.dailyCeiling.toString()}
                  </option>
                ))}
            </select>
          )}
        </Field>
        {policy && amountValue !== null && amountValue > policy.dailyCeiling && (
          <p className="text-sm text-danger-text">
            The amount is above this policy&apos;s public daily ceiling: the escrow does not open such a job, since no
            release could be paid under it.
          </p>
        )}
      </Section>

      <Section id="job-spec" title="Specification">
        <Field
          label="Job specification (JSON)"
          hint="Sent to the agent over A2A. Only its hash goes on chain: SHA-256 of the RFC 8785 canonical form."
          error={specText === '' ? null : spec.ok ? null : spec.error}
        >
          {({ id, describedBy, invalid }) => (
            <textarea
              id={id}
              className={`${inputClass} min-h-40`}
              value={specText}
              onChange={(event) => setSpecText(event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              spellCheck={false}
              disabled={existingJob !== null}
            />
          )}
        </Field>
        {spec.ok && (
          <dl className="grid gap-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted">spec_hash</dt>
              <dd>
                <code className="break-all font-mono text-caption">{hex(spec.hash)}</code>
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted">Canonical form</dt>
              <dd>
                <CopyButton value={spec.canonical} label="Copy the canonical specification" />
              </dd>
            </div>
            {jobAddress && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted">Job account</dt>
                <dd className="flex items-center gap-2">
                  <Address value={jobAddress} label="job" />
                  {existingJob && <StatusBadge tone="info">{statusLabel(existingJob.status)}</StatusBadge>}
                  {existingJob && (
                    <Link href={`/app/jobs/${jobAddress}`} className="text-link underline">
                      Open the job
                    </Link>
                  )}
                </dd>
              </div>
            )}
          </dl>
        )}
        {existingJob && (
          <p className="text-sm text-muted">
            A job with this specification already exists for this wallet; the specification is part of its address.
          </p>
        )}
      </Section>

      {!existingJob && travelRule && (
        <p className="rounded-card border border-border bg-surface p-6 text-sm text-muted">
          This amount is at or above the Travel Rule threshold (
          {formatUnits(setup.travelRuleThreshold, token?.decimals ?? 0)} USDC). Once the job is created, you enter the
          originator and beneficiary here; the Square API stores the record encrypted and you bind its commitment before
          funding.
        </p>
      )}
      {existingJob && jobAddress && (travelRule || isBound(existingJob.commitment)) && (
        <JobTravelRule
          setup={setupLoad.value.setup}
          jobAddress={jobAddress}
          job={existingJob}
          institution={ownerKey}
          api={apiClient}
          verification={travelVerification}
          onVerification={setTravelVerification}
          formatAmount={(base) => (token ? `${formatUnits(base, token.decimals)} USDC` : base.toString())}
          onConfirmed={onTravelRuleConfirmed}
        />
      )}

      <Section id="job-fund" title={fiat ? 'Create' : 'Create and fund'}>
        {screening?.state === 'loading' && <p className="text-sm text-muted">Reading the sanctions screenings…</p>}
        {screening?.state === 'error' && (
          <p className="text-sm text-danger-text">The screenings could not be read: {screening.message}</p>
        )}
        {screening?.state === 'ready' && (
          <dl className="grid gap-2 text-sm" aria-label="Sanctions screening">
            {(
              [
                ['Institution', screening.value.institution],
                ['Agent wallet', screening.value.agent],
              ] as const
            ).map(([who, s]) => (
              <div key={who} className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted">{who} screening</dt>
                <dd className="flex items-center gap-2">
                  <StatusBadge tone={SCREENING_TONE[s.state]}>{SCREENING_TEXT[s.state]}</StatusBadge>
                  {s.state !== 'missing' && (
                    <span className="text-caption text-muted">
                      until{' '}
                      <time dateTime={new Date(s.expiresAt * 1000).toISOString()}>
                        {new Date(s.expiresAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}
                      </time>
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {fundBlock && <p className="text-sm text-danger-text">{fundBlock}</p>}
        {!fiat && token && balance && (
          <p className="text-sm">
            Balance: <span className="font-mono">{formatUnits(balance.amount ?? 0n, token.decimals)} USDC</span>
            {insufficient && <span className="text-danger-text"> — not enough to fund this job.</span>}
          </p>
        )}
        {existingJob?.status === 'open' && travelBlock && <p className="text-sm text-danger-text">{travelBlock}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void run('create')} loading={busy === 'create'} disabled={!canCreate || busy !== null}>
            Create the job
          </Button>
          {!fiat && (
            <Button
              variant="secondary"
              onClick={() => void run('fund')}
              loading={busy === 'fund'}
              disabled={!canFund || busy !== null}
            >
              Fund the job
            </Button>
          )}
          {!guard.canTransact && guard.problems.length > 0 && (
            <p className="text-sm text-danger-text">{guard.problems.join(' ')}</p>
          )}
        </div>
        <p className="text-caption text-muted">
          {fiat
            ? 'Signed by this wallet: create_fiat_job opens the job without a vault once both wallets are screened clear. You then bind the pre-acceptance proof on the job page; the agent can accept only after it. After the agent delivers, you pay by card on the job page and bind the payment with its compliance proof.'
            : "Transactions signed by this wallet: create_job opens the job and its vault; above the Travel Rule threshold commit_travel_rule binds the record's commitment; fund_job moves the amount into the vault once both wallets are screened clear. With a policy, you then bind the pre-acceptance proof on the job page: the agent can accept only after it."}
        </p>
        {error && <p className="text-sm text-danger-text">{error}</p>}
        {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
      </Section>
    </div>
  );
}
