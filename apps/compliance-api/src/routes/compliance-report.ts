import { Router } from 'express';
import type { Request } from 'express';
import type { ApiResponse } from '@aperture/types';
import { requireX402Payment, type X402PaymentProof } from '../middleware/x402.js';
import { getProofRecordsByOperator } from '../models/proof-record.js';
import { getAttestationsByOperator } from '../models/attestation.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Price: 1 USDC = 1,000,000 lamports (6 decimals)
const REPORT_PRICE_LAMPORTS = 1_000_000;

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
    readonly amount: string;
    readonly zk_proof_hash: string | null;
  };
}

/**
 * @swagger
 * /api/v1/compliance/protected-report:
 *   get:
 *     summary: Get compliance report (x402 payment required - 1 USDC)
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
 *       402:
 *         description: Payment required
 */
router.get(
  '/protected-report',
  requireX402Payment(REPORT_PRICE_LAMPORTS, 'Aperture Compliance Report - 1 USDC'),
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

      const payment = (req as Request & { x402Payment: X402PaymentProof }).x402Payment;

      // Fetch proof records
      const { records: proofs, total: totalProofs } = await getProofRecordsByOperator(
        operatorId,
        1,
        100
      );

      const compliantProofs = proofs.filter((p) => p.is_compliant).length;
      const nonCompliantProofs = totalProofs - compliantProofs;
      const complianceRate =
        totalProofs > 0 ? ((compliantProofs / totalProofs) * 100).toFixed(1) : '0.0';

      // Fetch attestations
      const { attestations, total: totalAttestations } = await getAttestationsByOperator(
        operatorId,
        1,
        100
      );

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
          tx_signature: payment.txSignature,
          payer: payment.payer,
          amount: '1 USDC',
          zk_proof_hash: payment.zkProofHash ?? null,
        },
      };

      logger.info('Compliance report generated via x402', {
        operator_id: operatorId,
        total_proofs: totalProofs,
        tx_signature: payment.txSignature,
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
  }
);

export default router;
