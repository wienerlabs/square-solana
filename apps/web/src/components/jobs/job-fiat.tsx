'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PublicKey } from '@solana/web3.js';
import {
  buildReleaseWitness,
  buildVerifyMppPaymentProofTx,
  CLOCK_TOLERANCE_SECS,
  createRemoteProver,
  isFinalRefusal,
  SIGNAL,
} from '@squaresdk/solana-policy';
import type { JobAccount, SquareApi } from '@squaresdk/solana-sdk';
import type {
  ApiEnvelope,
  FiatAttestation,
  FiatAttestationSource,
  FiatConfig,
  FiatCustomer,
  FiatPayment,
  ProveResponse,
} from '@squaresdk/solana-types';
import { useActor } from '@/components/actor';
import { useApiClient, type ApiClientState } from '@/components/api-client';
import { ApiSessionPanel } from '@/components/api-session-panel';
import { CardField, type CardInput } from '@/components/fiat/card-field';
import { useNetworkGuard } from '@/components/network-guard';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/ui/status-badge';
import { TxConfirmation } from '@/components/ui/tx-confirmation';
import { ProverInputs } from './prover-inputs';
import { ENV_VARS } from '@/lib/config';
import {
  attestationSignature,
  fiatAmount,
  fiatPaymentErrorText,
  formatUsd,
  PAYMENT_STATUS_TEXT,
  PRECHECK_RECEIPT_SIGNAL,
  precheckRemaining,
  receiptSignal,
  stripeErrorText,
} from '@/lib/fiat';
import { finalizeErrorMessage, readSettlement, VALIDATION_TEXT, type Settlement } from '@/lib/job-settlement';
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
import type { SettlementToken } from '@/lib/settlement';
import { SquareApiError, unwrap } from '@/lib/square-api';
import { stripeFor } from '@/lib/stripe';
import { useSignatureStatus } from '@/lib/use-signature-status';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const refusalOf = (proof: ProveResponse) => Number(BigInt(`0x${proof.publicInputs[SIGNAL.refusalCode]!}`));
const isNotFound = (error: unknown) => error instanceof SquareApiError && error.code === 'not_found';

const SOURCE_TEXT: Readonly<Record<FiatAttestationSource, string>> = {
  webhook: "Stripe's signed webhook",
  reconcile: "the institution's check with Stripe",
  mpp: 'the MPP payment request',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
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

/** Zarfı açar; `not_found` "yok" demektir (null), diğer hatalar `fail`'e gider. */
function readOptional<T>(
  request: Promise<ApiEnvelope<T>>,
  done: (load: Load<T | null>) => void,
  fail: (error: unknown) => string,
): void {
  request.then(
    (envelope) => {
      try {
        done({ state: 'ready', value: unwrap(envelope) });
      } catch (caught) {
        done(isNotFound(caught) ? { state: 'ready', value: null } : { state: 'error', message: fail(caught) });
      }
    },
    (caught: unknown) => done({ state: 'error', message: fail(caught) }),
  );
}

/**
 * Fiat iş (FE-20, ADR 0024 / 0026): kurum teslim edilen işin tutarını kartla öder, MPP authority'nin attestation'ı ve
 * uyum ispatı `verify_mpp_payment_proof` ile bağlanır, ardından herkes `finalize_fiat_payment` ile işi `Released`
 * yapar. Ödemeden önce gizli politika bu tarayıcıda denetlenir: ödeme alınıp ispat bağlanamazsa para iade edilemez.
 * Escrow, dispute ve alacak satışı fiat işte yoktur.
 */
export function JobFiat({
  escrow,
  jobKey,
  account,
  release,
  chainNow,
  revision,
  token,
  formatAmount,
  onConfirmed,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  /** İş detayının okuduğu ispat durumu (`readReleaseState`). */
  release: Load<ReleaseState>;
  chainNow: number | null;
  revision: number;
  token: SettlementToken | null;
  formatAmount(base: bigint): string;
  onConfirmed(): void;
}) {
  const institutionActor = useActor('institution');
  const api = useApiClient(institutionActor.api);
  const { publicApi, report } = api;
  const isInstitution = Boolean(institutionActor.address?.equals(account.institution));
  const status = Object.keys(account.status)[0]!;
  const amount = BigInt(account.amount.toString());

  // Yayımlanabilir anahtar ve en düşük tutar herkese açık uçtan (`getFiatConfig`).
  const [config, setConfig] = useState<Load<FiatConfig> | null>(null);
  useEffect(() => {
    if (!publicApi) {
      setConfig(null);
      return;
    }
    let active = true;
    setConfig({ state: 'loading' });
    const failed = (caught: unknown) => active && setConfig({ state: 'error', message: fiatPaymentErrorText(caught) });
    publicApi.getFiatConfig().then((envelope) => {
      if (!active) return;
      try {
        setConfig({ state: 'ready', value: unwrap(envelope) });
      } catch (caught) {
        failed(caught);
      }
    }, failed);
    return () => {
      active = false;
    };
  }, [publicApi]);

  // Attestation yalnızca kurumun yetkilisine açıktır (oturumla); ödeme yoksa null.
  const signedIn = api.api;
  const job = jobKey.toBase58();
  const [attestation, setAttestation] = useState<Load<FiatAttestation | null> | null>(null);
  const [reread, setReread] = useState(0);
  useEffect(() => {
    if (!isInstitution || !signedIn || (status !== 'delivered' && status !== 'released')) {
      setAttestation(null);
      return;
    }
    let active = true;
    readOptional(signedIn.getFiatAttestation(job), (load) => active && setAttestation(load), report);
    return () => {
      active = false;
    };
  }, [isInstitution, signedIn, status, job, revision, reread, report]);
  const paid = useCallback((value: FiatAttestation) => setAttestation({ state: 'ready', value }), []);
  const rereadAttestation = useCallback(() => setReread((n) => n + 1), []);

  const proof = release.state === 'ready' ? release.value.proof : null;
  const outlook =
    release.state === 'ready' && chainNow !== null ? releaseOutlook(release.value, account, null, chainNow) : null;
  const known = attestation?.state === 'ready' ? attestation.value : null;
  const payable = config?.state === 'ready' && token ? fiatAmount(amount, token.decimals, config.value) : null;

  const badge: { tone: Tone; text: string } =
    status === 'released'
      ? { tone: 'success', text: 'Released' }
      : status === 'cancelled'
        ? { tone: 'neutral', text: 'Cancelled' }
        : status !== 'delivered'
          ? { tone: 'neutral', text: 'Due on delivery' }
          : known || proof
            ? { tone: 'info', text: 'Paid' }
            : { tone: 'warning', text: 'Awaiting payment' };

  return (
    <section aria-labelledby="fiat-heading" className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="fiat-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
          Card payment
        </h2>
        <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
      </div>
      <dl className="mt-4 grid gap-2 text-sm">
        <Row label="Amount">
          <span className="font-mono">{payable?.ok ? formatUsd(payable.cents) : formatAmount(amount)}</span>
          <span className="text-caption text-muted">in USD, by card</span>
        </Row>
        <Row label="Paid to">
          <span>Square&apos;s Stripe account</span>
          <span className="text-caption text-muted">
            the agent is not paid out in USD in this version; the release records the delivery
          </span>
        </Row>
      </dl>
      {config?.state === 'loading' && <p className="mt-3 text-sm text-muted">Reading the card payment settings…</p>}
      {config === null && (
        <p className="mt-3 text-sm text-muted">
          Card payments go through the Square API, and <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set.
        </p>
      )}
      {config?.state === 'error' && <p className="mt-3 text-sm text-danger-text">{config.message}</p>}
      {payable && !payable.ok && (
        <p className="mt-3 text-sm text-danger-text">This job cannot be paid by card: {payable.reason}</p>
      )}

      <div className="mt-3 text-sm">
        {(status === 'open' || status === 'accepted') && (
          <p>
            The institution pays by card once the agent delivers. There is no escrow, challenge window or dispute: the
            institution&apos;s payment accepts the delivery.
          </p>
        )}
        {status === 'delivered' && !known && !proof && !isInstitution && (
          <p>Delivered. Waiting for the institution to pay by card and bind its compliance proof.</p>
        )}
        {status === 'delivered' && proof && !proof.consumed && (
          <p>
            The card payment is attested and its compliance proof is bound
            {outlook?.kind === 'pays'
              ? ': anyone can finalize the job now.'
              : outlook?.kind === 'stale'
                ? `, but the proof went stale: ${outlook.reasons.join(' ')} The institution binds a fresh one.`
                : '.'}
          </p>
        )}
        {status === 'cancelled' && <p>The job was cancelled before it was paid; nothing was charged.</p>}
      </div>

      {isInstitution &&
        config?.state === 'ready' &&
        payable?.ok &&
        (status === 'delivered' || status === 'released') && (
          <FiatInstitution
            escrow={escrow}
            jobKey={jobKey}
            account={account}
            api={api}
            config={config.value}
            cents={payable.cents}
            attestation={attestation}
            release={release}
            outlook={outlook}
            chainNow={chainNow}
            formatAmount={formatAmount}
            onPaid={paid}
            onReread={rereadAttestation}
          />
        )}

      {status === 'delivered' && outlook?.kind === 'pays' && (
        <FinalizeFiat escrow={escrow} jobKey={jobKey} onConfirmed={onConfirmed} />
      )}

      {status === 'released' && <Released escrow={escrow} jobKey={jobKey} account={account} revision={revision} />}
    </section>
  );
}

interface ProofInputs {
  policy: PolicyMaterial;
  category: string;
  apiKey: string;
  proverUrl: string;
}

/** Kurumun yetkilisinin adımları: oturum, ön denetim, ödeme, makbuz ve ispatın bağlanması. */
function FiatInstitution({
  escrow,
  jobKey,
  account,
  api,
  config,
  cents,
  attestation,
  release,
  outlook,
  chainNow,
  formatAmount,
  onPaid,
  onReread,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  api: ApiClientState;
  config: FiatConfig;
  cents: number;
  attestation: Load<FiatAttestation | null> | null;
  release: Load<ReleaseState>;
  outlook: ReleaseOutlook | null;
  chainNow: number | null;
  formatAmount(base: bigint): string;
  onPaid(attestation: FiatAttestation): void;
  onReread(): void;
}) {
  const actor = useActor('institution');
  const { proverUrl } = useWebConfig();
  // Yalnızca kurum adına (cüzdan ya da smart account vault'u, FE-21) çizilir.
  const owner = actor.address!;
  const status = Object.keys(account.status)[0]!;

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

  const frame = (children: ReactNode) => <div className="mt-4 grid gap-4 border-t border-border pt-4">{children}</div>;
  if (!api.api) return frame(<ApiSessionPanel session={api} purpose="Paying by card and reading the receipt" />);
  if (attestation === null || attestation.state === 'loading') {
    return frame(<p className="text-sm text-muted">Reading the payment…</p>);
  }
  if (attestation.state === 'error') {
    return frame(<p className="text-sm text-danger-text">The payment could not be read: {attestation.message}</p>);
  }
  const receipt = attestation.value;
  // Bağlı ve taze ispat (ya da tüketilmiş ispat) varsa yeni ispat gerekmez.
  const proofDone = outlook?.kind === 'pays' || outlook?.kind === 'consumed';
  if (status === 'released' || (receipt && proofDone)) return receipt ? frame(<Receipt attestation={receipt} />) : null;

  // İspat ödemeden önce de sonra da bu tarayıcıda kurulur; kurulamıyorsa ödeme açılmaz.
  const multisigVault = release.state === 'ready' ? release.value.multisigVault : null;
  const problem: ReactNode = multisigVault ? (
    `This institution's authority is its Squads vault (${multisigVault.toBase58()}); its proof is bound by a vault transaction, not from this page.`
  ) : !proverUrl ? (
    <>
      Proofs are made by a prover service, and <span className="font-mono">{ENV_VARS.proverUrl}</span> is not set.
    </>
  ) : material && !material.ok ? (
    <>
      {material.reason}{' '}
      <Link href="/app/policy" className="text-link underline">
        Policy page
      </Link>
    </>
  ) : null;
  if (problem) {
    return frame(
      <>
        <p className="text-sm text-danger-text">{problem}</p>
        {receipt ? (
          <Receipt attestation={receipt} />
        ) : (
          <p className="text-sm text-muted">
            Paying is not offered here: a card payment whose compliance proof cannot be bound cannot be refunded.
          </p>
        )}
      </>,
    );
  }
  if (!material?.ok || release.state !== 'ready' || !proverUrl) return null;

  const policy = material.material;
  const inputs: ProofInputs = { policy, category: category || policy.categories[0] || '', apiKey, proverUrl };
  return frame(
    <>
      <ProverInputs
        categories={policy.categories}
        category={inputs.category}
        onCategory={setCategory}
        apiKey={apiKey}
        onApiKey={setApiKey}
        disabled={false}
      />
      <p className="text-caption text-muted">
        Proofs are made by the prover at <span className="font-mono">{new URL(proverUrl).host}</span>:{' '}
        <strong className="font-medium text-text">
          whoever runs that prover sees this policy (limits, blocked addresses, categories, salts).
        </strong>
      </p>
      {receipt ? (
        <>
          <Receipt attestation={receipt} />
          <BindPaymentProof
            escrow={escrow}
            jobKey={jobKey}
            account={account}
            state={release.value}
            outlook={outlook}
            attestation={receipt}
            inputs={inputs}
            chainNow={chainNow}
          />
        </>
      ) : (
        <Pay
          escrow={escrow}
          jobKey={jobKey}
          institution={account.institution.toBase58()}
          api={api.api}
          report={api.report}
          config={config}
          cents={cents}
          inputs={inputs}
          chainNow={chainNow}
          formatAmount={formatAmount}
          onPaid={onPaid}
          onReread={onReread}
        />
      )}
    </>,
  );
}

type Check = { madeAt: number; refusalCode: number; dailySpentBefore: bigint };

/** Ön denetim ve ödeme: kayıtlı kartla ya da Stripe'ın kart alanından. */
function Pay({
  escrow,
  jobKey,
  institution,
  api,
  report,
  config,
  cents,
  inputs,
  chainNow,
  formatAmount,
  onPaid,
  onReread,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  institution: string;
  api: SquareApi;
  report(error: unknown): string;
  config: FiatConfig;
  cents: number;
  inputs: ProofInputs;
  chainNow: number | null;
  formatAmount(base: bigint): string;
  onPaid(attestation: FiatAttestation): void;
  onReread(): void;
}) {
  const job = jobKey.toBase58();
  const [check, setCheck] = useState<Check | null>(null);
  const [customer, setCustomer] = useState<Load<FiatCustomer | null>>({ state: 'loading' });
  const [card, setCard] = useState<CardInput | null>(null);
  const [busy, setBusy] = useState<'check' | 'saved' | 'card' | 'reconcile' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Stripe ödemeyi işliyorsa (ör. `processing`) attestation sonra gelir; mutabakat yeniden sorulur.
  const [waiting, setWaiting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    readOptional(api.getFiatCustomer(institution), (load) => active && setCustomer(load), report);
    return () => {
      active = false;
    };
  }, [api, institution, report]);

  const failure = (caught: unknown) => {
    const generic = report(caught);
    return caught instanceof SquareApiError ? fiatPaymentErrorText(caught, formatAmount) : generic;
  };

  const runCheck = async () => {
    if (chainNow === null) return;
    setBusy('check');
    setError(null);
    setCheck(null);
    try {
      const witness = await buildReleaseWitness({
        client: escrow.client,
        job: jobKey,
        policy: inputs.policy.document,
        salts: inputs.policy.salts,
        paymentCategory: inputs.category,
        now: chainNow,
        stripeReceiptHash: PRECHECK_RECEIPT_SIGNAL,
      });
      const prover = createRemoteProver({
        baseUrl: inputs.proverUrl,
        apiKey: inputs.apiKey,
        artifactVersion: RELEASE_ARTIFACT_VERSION,
      });
      const proof = await prover.prove(witness);
      setCheck({
        madeAt: witness.timestamp,
        refusalCode: refusalOf(proof),
        dailySpentBefore: witness.dailySpentBefore,
      });
    } catch (caught) {
      setError(proverErrorMessage(caught, inputs.proverUrl));
    } finally {
      setBusy(null);
    }
  };

  /** Ödemenin sonucu: attestation geldiyse adım biter; ödeme tamamlandıysa attestation mutabakatla yazılır. */
  const settle = async (payment: Pick<FiatPayment, 'status' | 'attestation'>) => {
    if (payment.attestation) return onPaid(payment.attestation);
    if (payment.status === 'succeeded') return onPaid(unwrap(await api.reconcileFiatPayment(job)));
    setWaiting(PAYMENT_STATUS_TEXT[payment.status] ?? payment.status);
  };

  /** Stripe.js'in onayının sonucu. */
  const confirmed = async (result: Awaited<ReturnType<CardInput['stripe']['confirmCardPayment']>>) => {
    if (result.error) {
      setError(stripeErrorText(result.error));
      return;
    }
    await settle({ status: result.paymentIntent.status as FiatPayment['status'], attestation: null });
  };

  const paySaved = async () => {
    setBusy('saved');
    setError(null);
    setWaiting(null);
    try {
      try {
        await settle(unwrap(await api.createFiatPayment(job, { offSession: true })));
      } catch (caught) {
        // Banka kart sahibinin onayını istiyorsa aynı PaymentIntent Stripe'ın penceresiyle burada onaylanır.
        if (!(caught instanceof SquareApiError) || caught.details?.['status'] !== 'requires_action') throw caught;
        const open = unwrap(await api.createFiatPayment(job, { offSession: false }));
        if (!open.clientSecret) return await settle(open);
        const stripe = await stripeFor(config.publishableKey);
        await confirmed(await stripe.confirmCardPayment(open.clientSecret));
      }
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(null);
    }
  };

  const payCard = async () => {
    if (!card) return;
    setBusy('card');
    setError(null);
    setWaiting(null);
    try {
      const payment = unwrap(await api.createFiatPayment(job, { offSession: false }));
      if (!payment.clientSecret) return await settle(payment);
      await confirmed(
        await card.stripe.confirmCardPayment(payment.clientSecret, { payment_method: { card: card.card } }),
      );
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async () => {
    setBusy('reconcile');
    setError(null);
    try {
      onPaid(unwrap(await api.reconcileFiatPayment(job)));
      setWaiting(null);
    } catch (caught) {
      setError(isNotFound(caught) ? 'Stripe has not completed the payment yet.' : failure(caught));
      onReread();
    } finally {
      setBusy(null);
    }
  };

  const remaining = check !== null && chainNow !== null ? precheckRemaining(check.madeAt, chainNow) : 0;
  const cleared = check?.refusalCode === 0 && remaining > 0;
  const saved = customer.state === 'ready' ? customer.value?.card : null;
  const busyNow = busy !== null;

  return (
    <>
      <div className="grid gap-2">
        <h3 className="text-sm font-medium">1. Check the policy before paying</h3>
        <p className="text-sm text-muted">
          A card payment is not refunded once it is taken, and the job is released only with a compliant proof. The
          prover first evaluates this release against the policy; nothing is bound or paid.
        </p>
        <div>
          <Button
            variant={cleared ? 'secondary' : 'primary'}
            onClick={() => void runCheck()}
            loading={busy === 'check'}
            disabled={inputs.apiKey === '' || chainNow === null || busyNow}
          >
            {check ? 'Check again' : 'Check the policy'}
          </Button>
          {busy === 'check' && <span className="ml-3 text-sm text-muted">Proving…</span>}
        </div>
        {check?.refusalCode === 0 &&
          (cleared ? (
            <p className="text-sm">
              <StatusBadge tone="success">Compliant</StatusBadge> The release satisfies the policy at{' '}
              {iso(check.madeAt)} (chain time). Pay within {formatDuration(BigInt(remaining))}, or check again.
            </p>
          ) : (
            <p className="text-sm text-muted">The check is too old to pay on; check again.</p>
          ))}
        {check && check.refusalCode !== 0 && (
          <div className="text-sm">
            <p className="font-medium">
              {isFinalRefusal(check.refusalCode, check.dailySpentBefore)
                ? 'The policy refuses this release: a payment now could never be bound.'
                : 'The policy refuses this release for now; it may pass after the daily counter resets at midnight UTC.'}
            </p>
            <Reasons reasons={refusalReasons(check.refusalCode)} />
          </div>
        )}
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-medium">2. Pay {formatUsd(cents)}</h3>
        {customer.state === 'loading' && <p className="text-sm text-muted">Reading the saved card…</p>}
        {customer.state === 'error' && <p className="text-sm text-danger-text">{customer.message}</p>}
        {saved && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void paySaved()} loading={busy === 'saved'} disabled={!cleared || busyNow}>
              Pay with the saved {saved.brand} card ending {saved.last4}
            </Button>
            <span className="text-caption text-muted">
              expires {String(saved.expMonth).padStart(2, '0')}/{saved.expYear}
            </span>
          </div>
        )}
        {customer.state === 'ready' && !saved && (
          <p className="text-caption text-muted">
            No card is saved for this institution.{' '}
            <Link href="/app/account" className="text-link underline">
              Save one on the account page
            </Link>{' '}
            to pay without entering it.
          </p>
        )}
        <CardField
          publishableKey={config.publishableKey}
          label={saved ? 'Or pay with another card' : 'Card'}
          hint="Entered in Stripe's form and sent only to Stripe."
          disabled={busyNow}
          onInput={setCard}
        />
        <div>
          <Button onClick={() => void payCard()} loading={busy === 'card'} disabled={!cleared || !card || busyNow}>
            Pay {formatUsd(cents)} by card
          </Button>
        </div>
        {waiting && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>Stripe: {waiting}.</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void reconcile()}
              loading={busy === 'reconcile'}
              disabled={busyNow}
            >
              Check the payment again
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-danger-text">{error}</p>}
      </div>
    </>
  );
}

/** Kanonik makbuz ve MPP authority'nin attestation'ı (ADR 0026 madde 4). */
function Receipt({ attestation }: { attestation: FiatAttestation }) {
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-medium">Receipt</h3>
      <dl className="grid gap-2 text-sm">
        <Row label="Paid">
          <span className="font-mono">{formatUsd(attestation.amountMinor)}</span>
          <time className="text-caption text-muted" dateTime={iso(attestation.paidAt)}>
            {iso(attestation.paidAt)}
          </time>
        </Row>
        <Row label="Stripe payment">
          <code className="break-all font-mono text-caption">{attestation.paymentIntent}</code>
        </Row>
        <Row label="Receipt commitment">
          <code className="break-all font-mono text-caption">{attestation.receiptHash}</code>
        </Row>
        <Row label="Attested by">
          <Address value={attestation.authority} label="MPP authority" />
          <span className="text-caption text-muted">from {SOURCE_TEXT[attestation.source]}</span>
        </Row>
      </dl>
    </div>
  );
}

/** Ödemenin ispatı: makbuz commitment'ıyla üretilir, attestation'la birlikte `verify_mpp_payment_proof`'a bağlanır. */
function BindPaymentProof({
  escrow,
  jobKey,
  account,
  state,
  outlook,
  attestation,
  inputs,
  chainNow,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  state: ReleaseState;
  outlook: ReleaseOutlook | null;
  attestation: FiatAttestation;
  inputs: ProofInputs;
  chainNow: number | null;
}) {
  const actor = useActor('institution');
  const guard = useNetworkGuard();
  const owner = actor.address!;
  const [step, setStep] = useState<'idle' | 'proving' | 'binding'>('idle');
  const [refused, setRefused] = useState<{ refusalCode: number; dailySpentBefore: bigint } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const pending =
    signature !== null && status?.stage !== 'confirmed' && status?.stage !== 'finalized' && status?.stage !== 'failed';

  const proveAndBind = async () => {
    if (chainNow === null || !account.policy) return;
    setError(null);
    setRefused(null);
    setSignature(null);
    let phase: 'proving' | 'binding' = 'proving';
    try {
      setStep('proving');
      const witness = await buildReleaseWitness({
        client: escrow.client,
        job: jobKey,
        policy: inputs.policy.document,
        salts: inputs.policy.salts,
        paymentCategory: inputs.category,
        now: chainNow,
        stripeReceiptHash: receiptSignal(attestation),
      });
      const prover = createRemoteProver({
        baseUrl: inputs.proverUrl,
        apiKey: inputs.apiKey,
        artifactVersion: RELEASE_ARTIFACT_VERSION,
      });
      const proof = await prover.prove(witness);
      const refusalCode = refusalOf(proof);
      if (refusalCode !== 0) {
        setRefused({ refusalCode, dailySpentBefore: witness.dailySpentBefore });
        return;
      }
      phase = 'binding';
      setStep('binding');
      const built = await buildVerifyMppPaymentProofTx(
        escrow.client,
        {
          authority: owner,
          institution: state.institution,
          policy: account.policy,
          job: jobKey,
          proof,
          attestationSignature: attestationSignature(attestation),
        },
        await actor.options(),
      );
      setSignature(await actor.send(built.transaction));
    } catch (caught) {
      setError(
        phase === 'proving'
          ? proverErrorMessage(caught, inputs.proverUrl)
          : sendErrorText(caught, verifierErrorMessage),
      );
    } finally {
      setStep('idle');
    }
  };

  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">{outlook?.kind === 'stale' ? 'Bind a fresh proof' : 'Bind the payment'}</h3>
      <p className="text-sm text-muted">
        The proof carries the receipt commitment, and the transaction carries the MPP authority&apos;s signature over
        the job, the receipt and the amount; the verifier checks both. A proof binds only within{' '}
        {CLOCK_TOLERANCE_SECS / 60} minutes of chain time, so it is made and bound in one step.
      </p>
      {outlook?.kind === 'stale' && <Reasons reasons={outlook.reasons} />}
      <div>
        <Button
          onClick={() => void proveAndBind()}
          loading={step !== 'idle'}
          disabled={inputs.apiKey === '' || chainNow === null || !guard.canTransact || step !== 'idle' || pending}
        >
          Prove and bind
        </Button>
        {step === 'proving' && <span className="ml-3 text-sm text-muted">Proving…</span>}
        {step === 'binding' && <span className="ml-3 text-sm text-muted">Sending the binding…</span>}
      </div>
      {refused && (
        <div className="text-sm">
          <p className="font-medium">
            {isFinalRefusal(refused.refusalCode, refused.dailySpentBefore)
              ? 'The policy refuses this release, so the proof cannot be bound and the job cannot be released.'
              : 'The policy refuses this release for now; make the proof again after the daily counter resets at midnight UTC.'}
          </p>
          <Reasons reasons={refusalReasons(refused.refusalCode)} />
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

/** `finalize_fiat_payment`: herkese açık; tetikleyen itibar ve validation kaydının rent'ini öder, ücret yoktur. */
function FinalizeFiat({
  escrow,
  jobKey,
  onConfirmed,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  onConfirmed(): void;
}) {
  // Finalize herkese açık: tetikleyen cüzdandır (sponsorlu olabilir, FE-21), smart account değil.
  const actor = useActor(null);
  const guard = useNetworkGuard();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const status = useSignatureStatus(signature);
  const confirmed = status?.stage === 'confirmed' || status?.stage === 'finalized';
  const pending = signature !== null && !confirmed && status?.stage !== 'failed';
  useEffect(() => {
    if (confirmed) onConfirmed();
  }, [confirmed, onConfirmed]);

  const finalize = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await actor.options();
      const built = await escrow.client.flow.finalizeFiatPayment({ payer: options.feePayer, job: jobKey }, options);
      setSignature(await actor.send(built.transaction));
    } catch (caught) {
      setError(sendErrorText(caught, finalizeErrorMessage));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-4 text-sm">
      <p>
        Finalizing consumes the proof, writes the validation record and the agent&apos;s reputation, and marks the job
        Released. Anyone can trigger it; whoever does pays those accounts&apos; rent, and there is no keeper fee.
      </p>
      {actor.address ? (
        <div>
          <Button onClick={() => void finalize()} loading={busy} disabled={!guard.canTransact || busy || pending}>
            Finalize the job
          </Button>
        </div>
      ) : (
        <p className="text-muted">Connect a wallet to finalize.</p>
      )}
      {error && <p className="text-danger-text">{error}</p>}
      {status && <TxConfirmation stage={status.stage} signature={signature ?? undefined} error={status.error} />}
    </div>
  );
}

/** Release'in kaydı: validation ve agent'ın itibarı (`finalize_fiat_payment`). */
function Released({
  escrow,
  jobKey,
  account,
  revision,
}: {
  escrow: EscrowSetup;
  jobKey: PublicKey;
  account: JobAccount;
  revision: number;
}) {
  const [settlement, setSettlement] = useState<Load<Settlement>>({ state: 'loading' });
  useEffect(() => {
    let active = true;
    readSettlement(escrow, jobKey, account).then(
      (value) => active && setSettlement({ state: 'ready', value }),
      (error: Error) => active && setSettlement({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [escrow, jobKey, account, revision]);
  const settledAt = account.settledAt.toNumber();
  return (
    <div className="mt-4 grid gap-2 border-t border-border pt-4 text-sm">
      <dl className="grid gap-2">
        <Row label="Released">
          <time dateTime={iso(settledAt)}>{iso(settledAt)}</time>
        </Row>
        {settlement.state === 'ready' && (
          <Row label="Validation">
            {settlement.value.validation ? (
              <span>{VALIDATION_TEXT[settlement.value.validation.outcome]}</span>
            ) : (
              <span className="text-muted">No validation record on chain.</span>
            )}
          </Row>
        )}
        {settlement.state === 'ready' && settlement.value.reputation && (
          <Row label="Agent's completed jobs">
            <span className="font-mono">{settlement.value.reputation.jobsCompleted.toString()}</span>
          </Row>
        )}
      </dl>
      {settlement.state === 'loading' && <p className="text-muted">Reading the validation record…</p>}
      {settlement.state === 'error' && (
        <p className="text-danger-text">The validation record could not be read: {settlement.message}</p>
      )}
    </div>
  );
}
