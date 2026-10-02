import { Router, type Request, type Response } from 'express';
import express from 'express';
// `stripe` exposes the constructor as the module default and the related
// types as namespaced exports off it. Under module:Node16 the default
// import alone does not surface StripeEvent / StripePaymentIntent —
// `import *` does. We still instantiate via a dynamic import inside getStripe
// below so the cold-start cost stays out of the request path.
// Stripe v22's bundled types changed shape under module:Node16; the
// `Stripe.Event` namespace path no longer resolves cleanly. Rather than wrap
// every Stripe SDK call in awkward casts, we narrow only the fields we read
// here. Anything else we touch must be re-typed if added later.
interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: { readonly object: unknown };
}

interface StripeChargeMinimal {
  readonly created: number;
}

interface StripePaymentIntentMinimal {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly currency: string;
  readonly customer?: string | { readonly id: string } | null;
  readonly latest_charge?: string | StripeChargeMinimal | null;
}

interface StripeInstance {
  readonly webhooks: {
    constructEvent(
      payload: Buffer | string,
      signatureHeader: string,
      secret: string,
    ): StripeEvent;
  };
}

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
  computeStripeReceiptHash,
  signReceiptHash,
  type CanonicalStripeReceipt,
} from '../utils/stripe-receipt.js';
import { upsertVerifiedPaymentIntent } from '../models/verified-payment-intent.js';

const router = Router();

let stripeInstance: StripeInstance | null = null;
async function getStripe(): Promise<StripeInstance> {
  if (!stripeInstance) {
    const StripeMod = (await import('stripe')).default;
    stripeInstance = new (StripeMod as unknown as new (
      key: string,
      opts: Record<string, unknown>,
    ) => StripeInstance)(config.stripe.secretKey, { apiVersion: config.stripe.apiVersion });
  }
  return stripeInstance;
}

/**
 * Adım 8a — Stripe webhook receiver.
 *
 * Stripe POSTs every PaymentIntent state change here. The handler:
 *
 *   1. Reads the request body as a raw Buffer (Stripe-Signature is
 *      computed over the unparsed bytes; passing it through express.json
 *      first would invalidate every signature).
 *   2. Verifies the Stripe-Signature header against STRIPE_WEBHOOK_SECRET
 *      via stripe.webhooks.constructEvent. Anything that fails this check
 *      is rejected with 400 — there is no fallback path.
 *   3. For payment_intent.succeeded events, builds the canonical receipt,
 *      Poseidon-hashes it (matching the in-circuit layout in Adım 8b),
 *      ed25519-signs the hash with MPP_AUTHORITY, and idempotently persists
 *      everything to verified_payment_intents.
 *   4. For other events the row is also persisted (status=… up to Stripe)
 *      so downstream queries can see the lifecycle, but the signature only
 *      enables on-chain attestation when status === 'succeeded'.
 *
 * No request from Stripe ever bypasses signature verification, and no
 * outbound state from this handler is created without a verified webhook
 * — that is the entire trust anchor of the B-mode flow.
 */

// IMPORTANT: this router is mounted with express.raw before the global
// express.json so the Stripe-Signature HMAC has access to the byte-perfect
// request body. The mounting order is enforced in src/index.ts.
router.post(
  '/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req: Request, res: Response): Promise<void> => {
    if (!config.stripe.webhookSecret || !config.mppAuthority.keypairBase58) {
      res.status(503).json({
        success: false,
        error:
          'Stripe webhook handler is not configured. Set STRIPE_WEBHOOK_SECRET and MPP_AUTHORITY_KEYPAIR_BASE58 in .env, then restart compliance-api.',
        data: null,
      });
      return;
    }
    const sigHeader = req.header('stripe-signature');
    if (!sigHeader) {
      res.status(400).send('Missing Stripe-Signature header');
      return;
    }

    let event: StripeEvent;
    try {
      const stripe = await getStripe();
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        sigHeader,
        config.stripe.webhookSecret,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'signature verify failed';
      logger.warn('Stripe webhook signature verification failed', { error: message });
      res.status(400).send(`Webhook Error: ${message}`);
      return;
    }

    if (event.type !== 'payment_intent.succeeded') {
      // We deliberately DO NOT short-circuit other events with 200/no-op;
      // Stripe re-delivers any non-2xx response and our DB persists what
      // it can so the lifecycle remains auditable.
      logger.info('Stripe webhook accepted (non-success)', {
        type: event.type,
        event_id: event.id,
      });
      res.status(200).send({ received: true, recorded: false });
      return;
    }

    const pi = event.data.object as StripePaymentIntentMinimal;
    if (!pi.id || pi.status !== 'succeeded') {
      logger.warn('Stripe webhook payment_intent.succeeded missing id/status', {
        event_id: event.id,
        pi_id: pi.id,
        status: pi.status,
      });
      res.status(400).send('PaymentIntent missing id or status');
      return;
    }

    // Stripe sometimes hands back a non-positive amount on test
    // transitions; reject so the canonical receipt always carries real
    // numeric data.
    if (typeof pi.amount !== 'number' || pi.amount <= 0) {
      res.status(400).send('PaymentIntent has non-positive amount');
      return;
    }

    const customer =
      typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? '';
    const paidAtUnix = (() => {
      const charge = pi.latest_charge ?? null;
      if (charge && typeof charge !== 'string' && charge.created) {
        return charge.created;
      }
      return event.created;
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

    await upsertVerifiedPaymentIntent({
      stripe_payment_intent_id: pi.id,
      amount_cents: pi.amount,
      currency: pi.currency.toLowerCase(),
      status: pi.status,
      customer: customer || null,
      stripe_event_id: event.id,
      poseidon_hash_hex: poseidonHashHex,
      authority_signature_b58: authoritySignatureB58,
      stripe_paid_at: new Date(paidAtUnix * 1000),
    });

    logger.info('Stripe webhook persisted', {
      event_id: event.id,
      pi_id: pi.id,
      poseidon_hash_hex: poseidonHashHex,
    });

    res.status(200).send({ received: true, recorded: true, pi_id: pi.id });
  },
);

export default router;
