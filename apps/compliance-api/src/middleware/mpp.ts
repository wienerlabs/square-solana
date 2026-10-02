import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Stripe as StripeType } from 'stripe';
import NodeCache from 'node-cache';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getVerifiedPaymentIntent } from '../models/verified-payment-intent.js';
import { getOperatorStripeCredentials } from '../models/operator-stripe-credentials.js';

export interface MPPChallenge {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  readonly expires: string;
  readonly request: {
    readonly amount: string;
    readonly currency: string;
    readonly description: string;
    readonly resource: string;
  };
  readonly stripe: {
    readonly paymentIntentId: string;
    readonly clientSecret: string;
  };
}

export interface MPPCredential {
  readonly challengeId: string;
  readonly paymentIntentId: string;
}

export interface MPPReceipt {
  readonly method: string;
  readonly status: 'success';
  readonly timestamp: string;
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  /// Poseidon commitment over the canonical Stripe receipt — the ZK circuit
  /// (Adım 8b) reproduces this value as public_inputs[9].
  readonly poseidon_hash_hex: string;
  /// Compliance-api MPP authority's ed25519 signature over poseidon_hash_hex.
  /// The B-flow verifier (Adım 8c) checks this in-program via the Solana
  /// ed25519 native precompile.
  readonly authority_signature_b58: string;
}

const challengeCache = new NodeCache({ stdTTL: 300 });

let stripeInstance: StripeType | null = null;

async function getStripe(): Promise<StripeType> {
  if (!stripeInstance) {
    const Stripe = (await import('stripe')).default;
    stripeInstance = new (Stripe as unknown as new (key: string, opts: Record<string, unknown>) => StripeType)(
      config.stripe.secretKey,
      { apiVersion: config.stripe.apiVersion },
    );
  }
  return stripeInstance;
}

function createChallengeId(
  data: Record<string, unknown>,
  secretKey: string,
): string {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(JSON.stringify(data));
  return hmac.digest('hex');
}

/**
 * MPP (Machine Payments Protocol) middleware.
 * If x-mpp-credential header is present, verifies the Stripe payment.
 * If not, creates a Stripe PaymentIntent and returns 402 with challenge.
 */
export function requireMPPPayment(
  amountCents: number,
  currency: string,
  description: string,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const credentialHeader = req.headers['x-mpp-credential'] as
      | string
      | undefined;

    if (!credentialHeader) {
      try {
        const stripe = await getStripe();
        // If the caller advertised an operator_id and that operator has a
        // saved Stripe Customer (configured from dashboard Settings → Agent
        // Stripe Configuration), pin the PaymentIntent to that customer.
        // The agent then confirms with off_session=true against the saved
        // payment_method; without the customer link Stripe rejects the
        // off_session confirm with "PaymentIntent has no Customer".
        const operatorIdHint =
          (req.query.operator_id as string | undefined) ?? undefined;
        let savedCustomer: string | null = null;
        if (operatorIdHint) {
          const creds = await getOperatorStripeCredentials(operatorIdHint);
          savedCustomer = creds?.stripe_customer_id ?? null;
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountCents,
          currency,
          payment_method_types: ['card'],
          ...(savedCustomer ? { customer: savedCustomer } : {}),
          metadata: {
            mpp_version: '1',
            mpp_resource: req.originalUrl,
            mpp_description: description,
            ...(operatorIdHint ? { aperture_operator_id: operatorIdHint } : {}),
          },
        });

        const challengeData = {
          realm: config.mpp.realm,
          method: 'stripe',
          intent: 'charge',
          request: {
            amount: (amountCents / 100).toFixed(2),
            currency,
            description,
            resource: req.originalUrl,
          },
          expires: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        };

        const challengeId = createChallengeId(
          challengeData,
          config.mpp.secretKey,
        );

        const challenge: MPPChallenge = {
          id: challengeId,
          ...challengeData,
          stripe: {
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret!,
          },
        };

        challengeCache.set(challengeId, challenge);

        const challengeBase64 = Buffer.from(JSON.stringify(challenge)).toString(
          'base64',
        );
        res.setHeader(
          'WWW-Authenticate',
          `MPP realm="${config.mpp.realm}", challenge="${challengeBase64}"`,
        );

        logger.info('MPP challenge issued', {
          challengeId,
          paymentIntentId: paymentIntent.id,
          resource: req.originalUrl,
        });

        res.status(402).json({
          success: false,
          error: 'Payment Required',
          data: null,
          mppChallenge: challenge,
        });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Failed to create payment challenge';
        logger.error('MPP challenge creation failed', { error: message });
        res
          .status(500)
          .json({ success: false, error: message, data: null });
      }
      return;
    }

    try {
      const credential: MPPCredential = JSON.parse(
        Buffer.from(credentialHeader, 'base64').toString('utf-8'),
      );

      if (!credential.challengeId || !credential.paymentIntentId) {
        res.status(400).json({
          success: false,
          error:
            'Invalid MPP credential: missing challengeId or paymentIntentId',
          data: null,
        });
        return;
      }

      const cachedChallenge = challengeCache.get<MPPChallenge>(
        credential.challengeId,
      );
      if (!cachedChallenge) {
        res.status(402).json({
          success: false,
          error:
            'Challenge expired or not found. Please retry to get a new challenge.',
          data: null,
        });
        return;
      }

      if (
        cachedChallenge.stripe.paymentIntentId !== credential.paymentIntentId
      ) {
        res.status(402).json({
          success: false,
          error: 'PaymentIntent does not match challenge',
          data: null,
        });
        return;
      }

      // Authoritative source for "did this PaymentIntent succeed?" is the
      // signed Stripe webhook event we persisted in verified_payment_intents
      // (Adım 8a). Going back to Stripe's REST API would burn a round-trip
      // per request and bypass the canonical Poseidon hash + ed25519 sig
      // the on-chain verifier consumes downstream.
      const verified = await getVerifiedPaymentIntent(credential.paymentIntentId);
      if (!verified) {
        res.status(402).json({
          success: false,
          error:
            'Stripe webhook for this PaymentIntent has not yet been received. The compliance-api only acts on signature-verified webhook events; retry shortly after the Stripe Dashboard shows the charge as succeeded.',
          data: null,
        });
        return;
      }
      if (verified.status !== 'succeeded') {
        res.status(402).json({
          success: false,
          error: `Webhook recorded PaymentIntent status as "${verified.status}", not "succeeded".`,
          data: null,
        });
        return;
      }

      const receipt: MPPReceipt = {
        method: 'stripe',
        status: 'success',
        timestamp: verified.stripe_paid_at.toISOString(),
        reference: verified.stripe_payment_intent_id,
        amount: cachedChallenge.request.amount,
        currency: cachedChallenge.request.currency,
        poseidon_hash_hex: verified.poseidon_hash_hex,
        authority_signature_b58: verified.authority_signature_b58,
      };

      (req as Request & { mppReceipt: MPPReceipt }).mppReceipt = receipt;

      const receiptBase64 = Buffer.from(JSON.stringify(receipt)).toString(
        'base64',
      );
      res.setHeader('Payment-Receipt', receiptBase64);

      challengeCache.del(credential.challengeId);

      logger.info('MPP payment verified', {
        paymentIntentId: verified.stripe_payment_intent_id,
        amount: cachedChallenge.request.amount,
        resource: req.originalUrl,
      });

      next();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'MPP verification failed';
      logger.error('MPP verification error', { error: message });
      res.status(402).json({
        success: false,
        error: `MPP verification failed: ${message}`,
        data: null,
      });
    }
  };
}
