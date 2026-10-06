import { Router, type RequestHandler } from 'express';
import type { ApiResponse } from '../types/api.js';
import { getX402Payment } from '../middleware/x402.js';
import { getProofRecordsByOperator } from '../models/proof-record.js';
import { getAttestationsByOperator } from '../models/attestation.js';
import { logger } from '../utils/logger.js';

interface ComplianceReport {
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
    readonly tx_signature: string;
    readonly payer: string;
    /** Base units of `asset`. */
    readonly amount: string;
    readonly asset: string;
    /** CAIP-2. */
    readonly network: string;
  };
}

/**
 * @swagger
 * /api/v1/compliance/protected-report:
 *   get:
 *     summary: Get compliance report (x402 v2 payment required; price X402_REPORT_PRICE)
 *     description: >
 *       Without a PAYMENT-SIGNATURE header the answer is 402 with the payment requirements in the
 *       PAYMENT-REQUIRED header. The payment is settled before the report is built; the PAYMENT-RESPONSE
 *       header carries the receipt. A payment payload is accepted once.
 *     tags: [Compliance]
 *     parameters:
 *       - in: query
 *         name: operator_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Compliance report
 *       400:
 *         description: operator_id is missing (checked before any payment is taken)
 *       402:
 *         description: Payment required, invalid or already used
 */
export function createComplianceReportRouter(paywall: RequestHandler): Router {
  const router = Router();

  router.get(
    '/protected-report',
    (req, res, next) => {
      // Ödeme alınmadan önce: eksik parametre için ödeyen ücretlendirilmez.
      if (typeof req.query.operator_id !== 'string' || req.query.operator_id === '') {
        res.status(400).json({
          success: false,
          error: 'operator_id query parameter is required',
          data: null,
        });
        return;
      }
      next();
    },
    paywall,
    async (req, res, next) => {
      try {
        const operatorId = req.query.operator_id as string;
        const payment = getX402Payment(res);
        if (!payment?.settlement) {
          next(new Error('x402 payment missing behind the paywall'));
          return;
        }

        // Fetch proof records
        const { records: proofs, total: totalProofs } = await getProofRecordsByOperator(operatorId, 1, 100);

        const compliantProofs = proofs.filter((p) => p.is_compliant).length;
        const nonCompliantProofs = totalProofs - compliantProofs;
        const complianceRate = totalProofs > 0 ? ((compliantProofs / totalProofs) * 100).toFixed(1) : '0.0';

        // Fetch attestations
        const { attestations, total: totalAttestations } = await getAttestationsByOperator(operatorId, 1, 100);

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

        const report: ComplianceReport = {
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
            verified_at: p.verified_at instanceof Date ? p.verified_at.toISOString() : String(p.verified_at),
          })),
          payment: {
            tx_signature: payment.settlement.transaction,
            payer: payment.payer,
            amount: payment.amount,
            asset: payment.asset,
            network: payment.network,
          },
        };

        logger.info('Compliance report generated via x402', {
          operator_id: operatorId,
          total_proofs: totalProofs,
          tx_signature: payment.settlement.transaction,
        });

        const response: ApiResponse<ComplianceReport> = {
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

  return router;
}
