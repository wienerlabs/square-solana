import { Router } from 'express';
import type { Request } from 'express';
import type { ApiResponse } from '@aperture/types';
import {
  requireMPPPayment,
  type MPPReceipt,
} from '../middleware/mpp.js';
import { getProofRecordsByOperator } from '../models/proof-record.js';
import { getAttestationsByOperator } from '../models/attestation.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Price: $0.50 USD = 50 cents (Stripe minimum for USD)
const REPORT_PRICE_CENTS = 50;

interface MPPComplianceReport {
  readonly operator_id: string;
  readonly generated_at: string;
  readonly total_proofs: number;
  readonly compliant_proofs: number;
  readonly non_compliant_proofs: number;
  readonly compliance_rate: string;
  readonly total_attestations: number;
  readonly total_payment_volume: {
    readonly min: number;
    readonly max: number;
  };
  readonly policy_violations: number;
  readonly sanctions_intersections: number;
  readonly proof_records: readonly {
    readonly payment_id: string;
    readonly proof_hash: string;
    readonly is_compliant: boolean;
    readonly amount_range_min: number;
    readonly amount_range_max: number;
    readonly verified_at: string;
  }[];
  readonly payment: {
    readonly protocol: 'mpp';
    readonly method: string;
    readonly reference: string;
    readonly amount: string;
    readonly currency: string;
    readonly timestamp: string;
  };
}

/**
 * @swagger
 * /api/v1/compliance/mpp-report:
 *   get:
 *     summary: Get compliance report (MPP payment required - $0.50)
 *     tags: [Compliance]
 *     parameters:
 *       - in: query
 *         name: operator_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Compliance report with payment receipt
 *       402:
 *         description: Payment required (MPP challenge)
 */
router.get(
  '/mpp-report',
  requireMPPPayment(REPORT_PRICE_CENTS, 'usd', 'Aperture Compliance Report - $0.50'),
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

      const receipt = (req as Request & { mppReceipt: MPPReceipt })
        .mppReceipt;

      const { records: proofs, total: totalProofs } =
        await getProofRecordsByOperator(operatorId, 1, 100);

      const compliantProofs = proofs.filter((p) => p.is_compliant).length;
      const nonCompliantProofs = totalProofs - compliantProofs;
      const complianceRate =
        totalProofs > 0
          ? ((compliantProofs / totalProofs) * 100).toFixed(1)
          : '0.0';

      const { attestations, total: totalAttestations } =
        await getAttestationsByOperator(operatorId, 1, 100);

      let totalVolumeMin = 0;
      let totalVolumeMax = 0;
      let policyViolations = 0;
      let sanctionsIntersections = 0;

      for (const a of attestations) {
        totalVolumeMin += a.total_amount_range_min;
        totalVolumeMax += a.total_amount_range_max;
        policyViolations += a.policy_violations;
        sanctionsIntersections += a.sanctions_intersections;
      }

      const report: MPPComplianceReport = {
        operator_id: operatorId,
        generated_at: new Date().toISOString(),
        total_proofs: totalProofs,
        compliant_proofs: compliantProofs,
        non_compliant_proofs: nonCompliantProofs,
        compliance_rate: `${complianceRate}%`,
        total_attestations: totalAttestations,
        total_payment_volume: {
          min: totalVolumeMin,
          max: totalVolumeMax,
        },
        policy_violations: policyViolations,
        sanctions_intersections: sanctionsIntersections,
        proof_records: proofs.map((p) => ({
          payment_id: p.payment_id,
          proof_hash: p.proof_hash,
          is_compliant: p.is_compliant,
          amount_range_min: p.amount_range_min,
          amount_range_max: p.amount_range_max,
          verified_at:
            p.verified_at instanceof Date
              ? p.verified_at.toISOString()
              : String(p.verified_at),
        })),
        payment: {
          protocol: 'mpp',
          method: receipt.method,
          reference: receipt.reference,
          amount: receipt.amount,
          currency: receipt.currency,
          timestamp: receipt.timestamp,
        },
      };

      logger.info('Compliance report generated via MPP', {
        operator_id: operatorId,
        total_proofs: totalProofs,
        payment_reference: receipt.reference,
      });

      const response: ApiResponse<MPPComplianceReport> = {
        success: true,
        data: report,
        error: null,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
