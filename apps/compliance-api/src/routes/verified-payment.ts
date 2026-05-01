import { Router } from 'express';
import type { ApiResponse } from '@aperture/types';
import { getVerifiedPaymentIntent } from '../models/verified-payment-intent.js';
import { getAuthorityPublicKeyBase58 } from '../utils/stripe-receipt.js';

const router = Router();

/**
 * Adım 8e — agent polling endpoint.
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

export default router;
