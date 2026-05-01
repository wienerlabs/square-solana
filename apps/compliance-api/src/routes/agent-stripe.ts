import { Router } from 'express';
import type { Stripe as StripeType } from 'stripe';
import type { ApiResponse } from '@aperture/types';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
  deleteOperatorStripeCredentials,
  getOperatorStripeCredentials,
  upsertOperatorStripeCredentials,
} from '../models/operator-stripe-credentials.js';

const router = Router();

let stripeInstance: StripeType | null = null;

async function getStripe(): Promise<StripeType> {
  if (!stripeInstance) {
    const Stripe = (await import('stripe')).default;
    stripeInstance = new (Stripe as unknown as new (
      key: string,
      opts: Record<string, unknown>,
    ) => StripeType)(config.stripe.secretKey, { apiVersion: config.stripe.apiVersion });
  }
  return stripeInstance;
}

interface SetupIntentResponse {
  readonly client_secret: string;
  readonly customer_id: string;
}

interface CredentialsResponse {
  readonly operator_id: string;
  readonly stripe_customer_id: string;
  readonly stripe_payment_method_id: string;
  readonly card_brand: string | null;
  readonly card_last4: string | null;
}

/**
 * Adım 9 — Off-session agent payments.
 *
 * Endpoints the dashboard's "Agent Stripe Configuration" Settings panel and
 * the agent-service runtime use to set up + read the saved Customer +
 * PaymentMethod the agent will charge with off_session=true.
 *
 * Customer is created lazily on first /setup-intent call. The dashboard
 * confirms the SetupIntent client-side via stripe.confirmCardSetup, then
 * POSTs the resulting payment_method.id back to /credentials so the row
 * lives in our DB and the agent can find it next cycle.
 */

/**
 * POST /api/v1/agent/stripe/setup-intent
 *
 * Body: { operator_id }
 * Returns: { client_secret, customer_id }
 *
 * Lazy-creates a Stripe Customer (one per operator) the first time, then
 * returns a SetupIntent the dashboard can confirm with Stripe Elements.
 */
router.post('/agent/stripe/setup-intent', async (req, res, next) => {
  try {
    const operatorId = req.body?.operator_id as string | undefined;
    if (!operatorId || typeof operatorId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'operator_id required in request body',
        data: null,
      });
      return;
    }

    const stripe = await getStripe();
    const existing = await getOperatorStripeCredentials(operatorId);
    let customerId: string;
    if (existing) {
      customerId = existing.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        metadata: { aperture_operator_id: operatorId },
        description: `Aperture operator ${operatorId.slice(0, 8)}…`,
      });
      customerId = customer.id;
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      // off_session = saved card will be charged without the user present
      // (the agent runs unattended). usage='off_session' tells Stripe to
      // require any future-payment validation now (e.g. SCA / 3DS) so the
      // off_session charge cannot be blocked later.
      usage: 'off_session',
      metadata: { aperture_operator_id: operatorId },
    });

    const response: ApiResponse<SetupIntentResponse> = {
      success: true,
      data: {
        client_secret: setupIntent.client_secret!,
        customer_id: customerId,
      },
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/agent/stripe/credentials
 *
 * Body: { operator_id, payment_method_id, customer_id }
 * Returns: persisted credentials
 *
 * Called after stripe.confirmCardSetup(client_secret) succeeds in the
 * browser. We re-fetch the PaymentMethod from Stripe so card.last4 +
 * card.brand are read from the source of truth, not from a client-supplied
 * payload that could be tampered with.
 */
router.post('/agent/stripe/credentials', async (req, res, next) => {
  try {
    const operatorId = req.body?.operator_id as string | undefined;
    const paymentMethodId = req.body?.payment_method_id as string | undefined;
    const customerId = req.body?.customer_id as string | undefined;
    if (!operatorId || !paymentMethodId || !customerId) {
      res.status(400).json({
        success: false,
        error: 'operator_id, payment_method_id, customer_id all required',
        data: null,
      });
      return;
    }

    const stripe = await getStripe();
    // Re-attach the PaymentMethod to the customer if the dashboard
    // confirm did not already (creation via SetupIntent attaches it
    // automatically, but a SetupIntent re-use after detach would not).
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (!pm.customer) {
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });
    } else if (pm.customer !== customerId) {
      res.status(400).json({
        success: false,
        error: `PaymentMethod is attached to a different customer (${String(pm.customer)})`,
        data: null,
      });
      return;
    }

    // If the operator already had a saved card, detach the old one so
    // Stripe does not accumulate orphan PaymentMethods on the customer.
    const existing = await getOperatorStripeCredentials(operatorId);
    if (existing && existing.stripe_payment_method_id !== paymentMethodId) {
      try {
        await stripe.paymentMethods.detach(existing.stripe_payment_method_id);
      } catch (err) {
        logger.warn('Old PaymentMethod detach failed (ignored)', {
          old_pm: existing.stripe_payment_method_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const persisted = await upsertOperatorStripeCredentials({
      operator_id: operatorId,
      stripe_customer_id: customerId,
      stripe_payment_method_id: paymentMethodId,
      card_brand: pm.card?.brand ?? null,
      card_last4: pm.card?.last4 ?? null,
    });

    const response: ApiResponse<CredentialsResponse> = {
      success: true,
      data: {
        operator_id: persisted.operator_id,
        stripe_customer_id: persisted.stripe_customer_id,
        stripe_payment_method_id: persisted.stripe_payment_method_id,
        card_brand: persisted.card_brand,
        card_last4: persisted.card_last4,
      },
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/agent/stripe/credentials/:operatorId
 *
 * Returns 200 with credentials if the operator has saved a card,
 * 404 otherwise. The agent-service uses 404 as the signal to skip the
 * MPP B-flow cycle.
 */
router.get('/agent/stripe/credentials/:operatorId', async (req, res, next) => {
  try {
    const credentials = await getOperatorStripeCredentials(req.params.operatorId);
    if (!credentials) {
      res.status(404).json({
        success: false,
        error: 'No saved Stripe credentials for this operator',
        data: null,
      });
      return;
    }
    const response: ApiResponse<CredentialsResponse> = {
      success: true,
      data: {
        operator_id: credentials.operator_id,
        stripe_customer_id: credentials.stripe_customer_id,
        stripe_payment_method_id: credentials.stripe_payment_method_id,
        card_brand: credentials.card_brand,
        card_last4: credentials.card_last4,
      },
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/agent/stripe/credentials/:operatorId
 *
 * Detaches the PaymentMethod on Stripe's side and removes the row.
 * Returns 200 even when the row didn't exist — idempotent.
 */
router.delete('/agent/stripe/credentials/:operatorId', async (req, res, next) => {
  try {
    const operatorId = req.params.operatorId;
    const existing = await getOperatorStripeCredentials(operatorId);
    if (existing) {
      const stripe = await getStripe();
      try {
        await stripe.paymentMethods.detach(existing.stripe_payment_method_id);
      } catch (err) {
        logger.warn('PaymentMethod detach failed (continuing with DB delete)', {
          pm: existing.stripe_payment_method_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await deleteOperatorStripeCredentials(operatorId);
    }
    res.json({ success: true, data: { removed: existing !== null }, error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
