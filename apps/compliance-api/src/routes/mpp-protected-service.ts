import { Router } from 'express';
import type { Request } from 'express';
import type { ApiResponse } from '@aperture/types';
import {
  requireMPPPayment,
  type MPPReceipt,
} from '../middleware/mpp.js';
import {
  requireOnchainMppProof,
  type OnchainMppProofView,
} from '../middleware/onchain-mpp-proof.js';
import { logger } from '../utils/logger.js';

const router = Router();

// $1.00 USD — the B-flow protected service is a richer read than the
// /mpp-report endpoint, so it costs more. Keeping the price as a literal
// here is intentional: the cents value is part of the Stripe PaymentIntent
// canonical receipt (Adım 8a), so silently changing it would invalidate
// every signed attestation already in the wild.
const SERVICE_PRICE_CENTS = 100;

/**
 * Adım 8e — MPP B-flow protected service endpoint.
 *
 * Demonstrates the full multi-rail compliance gate: caller proves they paid
 * via Stripe (signature-verified webhook in verified_payment_intents) AND
 * anchored a ZK proof on-chain (verify_mpp_payment_proof produced a
 * ProofRecord PDA whose Anchor account is consumed=true). Only then does
 * the endpoint serve the privileged response.
 *
 * The response itself is intentionally small — this is the demo surface
 * Coinbase-style auditors will run end-to-end. Production deployments wrap
 * the actual machine-protected service with the same two middlewares.
 */
interface MPPProtectedServiceResponse {
  readonly operator_id: string;
  readonly stripe_payment: {
    readonly payment_intent_id: string;
    readonly amount: string;
    readonly currency: string;
    readonly poseidon_hash_hex: string;
  };
  readonly onchain_proof: {
    readonly proof_record_pubkey: string;
    readonly operator: string;
    readonly amount_lamports: string;
  };
  readonly access_granted_at: string;
  readonly resource: string;
}

router.get(
  '/mpp-protected-service',
  requireMPPPayment(SERVICE_PRICE_CENTS, 'usd', 'Aperture MPP Protected Service - $1.00'),
  requireOnchainMppProof(),
  async (req, res, next) => {
    try {
      const operatorId = req.query.operator_id as string;
      if (!operatorId) {
        res.status(400).json({
          success: false,
          error: 'operator_id query parameter is required',
          data: null,
        });
        return;
      }

      const receipt = (req as Request & { mppReceipt: MPPReceipt }).mppReceipt;
      const onchain = (req as Request & { onchainProof: OnchainMppProofView }).onchainProof;

      // Reject the small but real cross-flow attack where the Stripe receipt
      // was signed under operator A but the on-chain proof was anchored under
      // operator B. Both halves of the proof MUST agree on the actor.
      if (onchain.operator !== operatorId) {
        res.status(403).json({
          success: false,
          error: `On-chain proof was anchored under operator ${onchain.operator}, not ${operatorId}.`,
          data: null,
        });
        return;
      }

      const response: ApiResponse<MPPProtectedServiceResponse> = {
        success: true,
        data: {
          operator_id: operatorId,
          stripe_payment: {
            payment_intent_id: receipt.reference,
            amount: receipt.amount,
            currency: receipt.currency,
            poseidon_hash_hex: receipt.poseidon_hash_hex,
          },
          onchain_proof: {
            proof_record_pubkey: onchain.proofRecordPubkey,
            operator: onchain.operator,
            amount_lamports: onchain.amountLamports.toString(),
          },
          access_granted_at: new Date().toISOString(),
          resource: req.originalUrl,
        },
        error: null,
      };

      logger.info('MPP B-flow service unlocked', {
        operator_id: operatorId,
        stripe_pi: receipt.reference,
        proof_pda: onchain.proofRecordPubkey,
      });

      res.json(response);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
