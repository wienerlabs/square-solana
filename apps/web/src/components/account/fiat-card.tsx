'use client';

import { useEffect, useState } from 'react';
import type { ApiEnvelope, FiatConfig, FiatCustomer } from '@squaresdk/solana-types';
import { useActor } from '@/components/actor';
import { useApiClient } from '@/components/api-client';
import { ApiSessionPanel } from '@/components/api-session-panel';
import { CardField, type CardInput } from '@/components/fiat/card-field';
import { Button } from '@/components/ui/button';
import { ENV_VARS } from '@/lib/config';
import { fiatPaymentErrorText, stripeErrorText } from '@/lib/fiat';
import { SquareApiError, unwrap } from '@/lib/square-api';

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

/** Kart Stripe'ta kaydedildikten sonra Square'in kaydı (webhook) en çok bu kadar yoklanır. */
const SAVED_CARD_POLLS = 5;
const SAVED_CARD_POLL_MS = 2_000;

const panel = 'rounded-card border border-border bg-surface p-6';
const heading = 'text-sm font-medium uppercase tracking-wide text-muted';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readCustomer(request: Promise<ApiEnvelope<FiatCustomer>>): Promise<FiatCustomer | null> {
  try {
    return unwrap(await request);
  } catch (error) {
    if (error instanceof SquareApiError && error.code === 'not_found') return null;
    throw error;
  }
}

/**
 * Kartla ödeme için kayıtlı kart (FE-20, ADR 0026 madde 3). Kart kurum anahtarı başınadır: kurum rolünün adresi
 * (cüzdan ya da smart account vault'u). SetupIntent Stripe'ın kart alanında onaylanır; Square kartı Stripe'ın
 * `setup_intent.succeeded` webhook'uyla kaydeder, öncekinin yerine. Kayıtlı kartla ödeme iş sayfasındadır.
 */
export function FiatCardPanel() {
  const actor = useActor('institution');
  const api = useApiClient(actor.api);
  const { publicApi, report } = api;
  const signedIn = api.api;
  const institution = actor.address?.toBase58() ?? null;

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

  const [customer, setCustomer] = useState<Load<FiatCustomer | null>>({ state: 'loading' });
  const [reread, setReread] = useState(0);
  useEffect(() => {
    if (!signedIn || !institution) return;
    let active = true;
    setCustomer({ state: 'loading' });
    readCustomer(signedIn.getFiatCustomer(institution)).then(
      (value) => active && setCustomer({ state: 'ready', value }),
      (caught: unknown) => active && setCustomer({ state: 'error', message: report(caught) }),
    );
    return () => {
      active = false;
    };
  }, [signedIn, institution, report, reread]);

  const [card, setCard] = useState<CardInput | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<'saving' | 'recording' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async () => {
    if (!signedIn || !institution || !card) return;
    setBusy('saving');
    setError(null);
    setNotice(null);
    try {
      const setup = unwrap(await signedIn.createFiatSetupIntent({ institution }));
      const result = await card.stripe.confirmCardSetup(setup.clientSecret, { payment_method: { card: card.card } });
      if (result.error) {
        setError(stripeErrorText(result.error));
        return;
      }
      const method = result.setupIntent.payment_method;
      const saved = typeof method === 'string' ? method : method?.id;
      // Square kartı Stripe'ın webhook'uyla kaydeder; kayıt gelene kadar birkaç kez okunur.
      setBusy('recording');
      for (let poll = 0; poll < SAVED_CARD_POLLS; poll += 1) {
        const value = await readCustomer(signedIn.getFiatCustomer(institution));
        if (value?.card && (!saved || value.card.paymentMethod === saved)) {
          setCustomer({ state: 'ready', value });
          setReplacing(false);
          return;
        }
        await wait(SAVED_CARD_POLL_MS);
      }
      setNotice("Stripe saved the card. Square records it when Stripe's webhook arrives; it shows here once recorded.");
      setReread((n) => n + 1);
    } catch (caught) {
      const generic = report(caught);
      setError(caught instanceof SquareApiError ? fiatPaymentErrorText(caught) : generic);
    } finally {
      setBusy(null);
    }
  };

  const body = () => {
    if (config === null) {
      return (
        <p className="text-sm text-muted">
          Card payments go through the Square API, and <span className="font-mono">{ENV_VARS.apiUrl}</span> is not set.
        </p>
      );
    }
    if (config.state === 'loading') return <p className="text-sm text-muted">Reading the card payment settings…</p>;
    if (config.state === 'error') return <p className="text-sm text-danger-text">{config.message}</p>;
    if (!signedIn) return <ApiSessionPanel session={api} purpose="Saving a card" />;
    if (customer.state === 'loading') return <p className="text-sm text-muted">Reading the saved card…</p>;
    if (customer.state === 'error') return <p className="text-sm text-danger-text">{customer.message}</p>;
    const saved = customer.value?.card ?? null;
    return (
      <div className="grid gap-3 text-sm">
        {saved ? (
          <p>
            Saved: {saved.brand} card ending <span className="font-mono">{saved.last4}</span>, expires{' '}
            <span className="font-mono">
              {String(saved.expMonth).padStart(2, '0')}/{saved.expYear}
            </span>
            . Jobs of this institution can be paid with it from the job page.
          </p>
        ) : (
          <p className="text-muted">No card is saved for this institution.</p>
        )}
        {saved && !replacing ? (
          <div>
            <Button variant="secondary" size="sm" onClick={() => setReplacing(true)}>
              Replace the card
            </Button>
          </div>
        ) : (
          <>
            <CardField
              publishableKey={config.value.publishableKey}
              label={saved ? 'New card' : 'Card'}
              hint="Entered in Stripe's form and sent only to Stripe. The bank may ask you to authenticate it."
              disabled={busy !== null}
              onInput={setCard}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void save()} loading={busy !== null} disabled={!card || busy !== null}>
                Save the card
              </Button>
              {busy === 'recording' && <span className="text-muted">Waiting for Square to record it…</span>}
            </div>
          </>
        )}
        {notice && <p>{notice}</p>}
        {error && <p className="text-danger-text">{error}</p>}
      </div>
    );
  };

  return (
    <section aria-labelledby="fiat-card-heading" className={panel}>
      <h2 id="fiat-card-heading" className={heading}>
        Card for fiat payments
      </h2>
      <p className="mt-2 text-sm text-muted">
        Card-paid jobs are paid in USD to Square&apos;s Stripe account. A saved card pays them without entering it each
        time; it belongs to this institution&apos;s key
        {actor.mode === 'smartAccount' ? ' (the smart account vault)' : ''}.
      </p>
      <div className="mt-4">{body()}</div>
    </section>
  );
}
