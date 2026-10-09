// Stripe.js (FE-20): kart bilgisi Stripe'ın çerçevesinde girilir ve doğrudan Stripe'a gider; Square'e ve bu sayfaya
// yalnızca PaymentIntent / SetupIntent sonucu döner. Yayımlanabilir anahtar Square API'sinden okunur
// (`getFiatConfig`); betik js.stripe.com'dan, ilk gerektiğinde yüklenir.
import { loadStripe, type Stripe, type StripeElementStyle } from '@stripe/stripe-js';

const loaded = new Map<string, Promise<Stripe | null>>();

/** Anahtarın Stripe istemcisi; betik sayfa başına bir kez yüklenir, yüklenemezse sonraki çağrı yeniden dener. */
export function stripeFor(publishableKey: string): Promise<Stripe> {
  let attempt = loaded.get(publishableKey);
  if (!attempt) {
    attempt = loadStripe(publishableKey);
    loaded.set(publishableKey, attempt);
    attempt.catch(() => {
      if (loaded.get(publishableKey) === attempt) loaded.delete(publishableKey);
    });
  }
  return attempt.then((stripe) => {
    if (!stripe) throw new Error('Stripe.js could not be loaded in this browser.');
    return stripe;
  });
}

/**
 * Kart alanının görünümü sayfanın temasından: Stripe'ın çerçevesi sayfanın CSS değişkenlerini görmez, renkler ve yazı
 * tipi alanın kabından okunur.
 */
export function cardStyle(element: HTMLElement): StripeElementStyle {
  const computed = getComputedStyle(element);
  const token = (name: string) => computed.getPropertyValue(name).trim() || computed.color;
  return {
    base: {
      color: computed.color,
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      iconColor: token('--color-muted'),
      '::placeholder': { color: token('--color-muted') },
    },
    invalid: { color: token('--color-danger-text'), iconColor: token('--color-danger-text') },
  };
}
