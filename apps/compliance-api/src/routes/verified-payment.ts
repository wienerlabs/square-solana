import { Router } from 'express';
import type { ApiResponse } from '@aperture/types';
import {
  getVerifiedPaymentIntent,
  upsertVerifiedPaymentIntent,
} from '../models/verified-payment-intent.js';
import {
  computeStripeReceiptHash,
  getAuthorityPublicKeyBase58,
  signReceiptHash,
  type CanonicalStripeReceipt,
} from '../utils/stripe-receipt.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Stripe SDK is async-imported and cached. Anything we read off the returned
// PaymentIntent is narrowed to the fields the canonical receipt builder needs;
// other fields stay untyped on purpose so a future Stripe schema change does
// not silently drift our type.
interface StripePaymentIntentShape {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly currency: string;
  readonly customer?: string | { readonly id: string } | null;
  readonly created: number;
  readonly latest_charge?: string | { readonly created?: number } | null;
}

interface StripeInstance {
  readonly paymentIntents: {
    retrieve(id: string): Promise<StripePaymentIntentShape>;
  };
}

let stripeInstance: StripeInstance | null = null;
async function getStripe(): Promise<StripeInstance> {
  if (!stripeInstance) {
    const StripeMod = (await import('stripe')).default;
    stripeInstance = new (StripeMod as unknown as new (
      key: string,
      opts: Record<string, unknown>,
    ) => StripeInstance)(config.stripe.secretKey, {
      apiVersion: config.stripe.apiVersion,
    });
  }
  return stripeInstance;
}

/**
 * Adım 8e - agent polling endpoint.
 *
 * After confirming an off-session Stripe PaymentIntent the agent polls this
 * endpoint until the corresponding webhook has fired and persisted a
 * verified_payment_intents row with the canonical Poseidon hash + ed25519
 * signature. The agent then feeds those values into its ZK proof + the
 * preceding ed25519 verify instruction.
 *
 * The route is read-only and intentionally NOT gated by MPP middleware —
 * the row's existence is itself the trust signal (the webhook handler in
 * Adım 8a only writes after Stripe-Signature verification). Returning the
 * authority pubkey alongside saves the agent a round-trip to compute the
 * expected ed25519 signer.
 */

interface VerifiedPaymentResponse {
  readonly stripe_payment_intent_id: string;
  readonly status: string;
  readonly amount_cents: number;
  readonly currency: string;
  readonly poseidon_hash_hex: string;
  readonly authority_signature_b58: string;
  readonly authority_pubkey_b58: string;
  readonly stripe_paid_at: string;
}

router.get('/verified-payment/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const v = await getVerifiedPaymentIntent(id);
    if (!v) {
      res.status(404).json({
        success: false,
        error: 'No verified payment intent recorded for that id',
        data: null,
      });
      return;
    }
    const response: ApiResponse<VerifiedPaymentResponse> = {
      success: true,
      data: {
        stripe_payment_intent_id: v.stripe_payment_intent_id,
        status: v.status,
        amount_cents: v.amount_cents,
        currency: v.currency,
        poseidon_hash_hex: v.poseidon_hash_hex,
        authority_signature_b58: v.authority_signature_b58,
        authority_pubkey_b58: getAuthorityPublicKeyBase58(),
        stripe_paid_at: v.stripe_paid_at.toISOString(),
      },
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /verified-payment/sync/:id
 *
 * Server-side fallback for environments where Stripe webhook delivery is not
 * wired up (no `stripe listen` and no public webhook endpoint registered with
 * the Stripe Dashboard). The dashboard calls this after
 * stripe.confirmCardPayment succeeds in the browser; the compliance-api
 * authenticates to Stripe with STRIPE_SECRET_KEY, retrieves the canonical
 * PaymentIntent object, and then runs the same hash + ed25519 sign + persist
 * pipeline the webhook handler does. The trust anchor moves from
 * "Stripe-Signature HMAC over a pushed event payload" to "TLS + secret key
 * authenticated GET against the Stripe REST API" - both are first-party
 * Stripe data, neither relies on client-supplied amounts or signatures.
 *
 * Idempotent: upsertVerifiedPaymentIntent uses ON CONFLICT (stripe_payment_intent_id),
 * so if the webhook later fires for the same PI it overwrites status/sig
 * fields with identical values.
 */
router.post('/verified-payment/sync/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id || !id.startsWith('pi_')) {
      res.status(400).json({
        success: false,
        error: 'Path parameter must be a Stripe PaymentIntent id (pi_...)',
        data: null,
      });
      return;
    }

    if (!config.stripe.secretKey) {
      res.status(503).json({
        success: false,
        error:
          'STRIPE_SECRET_KEY is not configured on the compliance-api; cannot sync PaymentIntent server-side.',
        data: null,
      });
      return;
    }
    if (!config.mppAuthority.keypairBase58) {
      res.status(503).json({
        success: false,
        error:
          'MPP_AUTHORITY_KEYPAIR_BASE58 is not configured; cannot sign the canonical receipt.',
        data: null,
      });
      return;
    }

    const stripe = await getStripe();
    let pi: StripePaymentIntentShape;
    try {
      pi = await stripe.paymentIntents.retrieve(id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Stripe paymentIntents.retrieve failed';
      logger.warn('Stripe PI retrieve failed during sync', {
        pi_id: id,
        error: message,
      });
      res.status(502).json({
        success: false,
        error: `Stripe API rejected paymentIntents.retrieve: ${message}`,
        data: null,
      });
      return;
    }

    if (pi.status !== 'succeeded') {
      res.status(409).json({
        success: false,
        error: `PaymentIntent status is "${pi.status}", expected "succeeded". The card may not have settled yet.`,
        data: null,
      });
      return;
    }
    if (typeof pi.amount !== 'number' || pi.amount <= 0) {
      res.status(409).json({
        success: false,
        error: 'PaymentIntent has non-positive amount; refusing to sign a receipt.',
        data: null,
      });
      return;
    }

    const customer =
      typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? '';

    // Mirror the webhook's paid_at logic: prefer the latest_charge.created so
    // the on-chain receipt timestamp matches when the funds actually settled,
    // fall back to PI.created when the expanded charge object is unavailable.
    const paidAtUnix = (() => {
      const charge = pi.latest_charge ?? null;
      if (charge && typeof charge !== 'string' && charge.created) {
        return charge.created;
      }
      return pi.created;
    })();

    const receipt: CanonicalStripeReceipt = {
      stripe_payment_intent_id: pi.id,
      amount_cents: pi.amount,
      currency: pi.currency.toLowerCase(),
      customer,
      paid_at_unix: paidAtUnix,
    };

    const poseidonHashHex = await computeStripeReceiptHash(receipt);
    const authoritySignatureB58 = signReceiptHash(poseidonHashHex);

    // Use the PI id as the synthetic event id so a later webhook delivery for
    // the same PI overwrites cleanly (the unique index is on PI id, not event
    // id, but the column is non-null). Prefix it to make the source obvious in
    // logs.
    const stripeEventId = `sync_${pi.id}`;

    const persisted = await upsertVerifiedPaymentIntent({
      stripe_payment_intent_id: pi.id,
      amount_cents: pi.amount,
      currency: pi.currency.toLowerCase(),
      status: pi.status,
      customer: customer || null,
      stripe_event_id: stripeEventId,
      poseidon_hash_hex: poseidonHashHex,
      authority_signature_b58: authoritySignatureB58,
      stripe_paid_at: new Date(paidAtUnix * 1000),
    });

    logger.info('Stripe PI synced server-side', {
      pi_id: pi.id,
      poseidon_hash_hex: poseidonHashHex,
    });

    const response: ApiResponse<VerifiedPaymentResponse> = {
      success: true,
      data: {
        stripe_payment_intent_id: persisted.stripe_payment_intent_id,
        status: persisted.status,
        amount_cents: persisted.amount_cents,
        currency: persisted.currency,
        poseidon_hash_hex: persisted.poseidon_hash_hex,
        authority_signature_b58: persisted.authority_signature_b58,
        authority_pubkey_b58: getAuthorityPublicKeyBase58(),
        stripe_paid_at: persisted.stripe_paid_at.toISOString(),
      },
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

export default router;
