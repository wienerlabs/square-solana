import { Router } from 'express';
import { z } from 'zod';
import type { ApiResponse, PaginatedResponse, Attestation, BatchAttestationOutput } from '@aperture/types';
import { validateBody } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import {
  createBatchAttestation,
  getAttestationById,
  getAttestationsByOperator,
  formatBatchOutput,
  updateTxSignature,
} from '../models/attestation.js';
import { getProofRecordsByOperatorAndPeriod } from '../models/proof-record.js';

const router = Router();

const UUIDSchema = z.string().uuid();
const OperatorIdSchema = z.string().min(1).max(64);

function paramAsString(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

const BatchAttestationInputSchema = z.object({
  operator_id: z.string().min(1).max(64),
  period_start: z.coerce.date(),
  period_end: z.coerce.date(),
}).refine(
  (data) => data.period_end > data.period_start,
  { message: 'period_end must be after period_start', path: ['period_end'] }
);

/**
 * @swagger
 * /api/v1/attestations/batch:
 *   post:
 *     summary: Create a batch attestation for an operator and time period
 *     tags: [Attestations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BatchAttestationInput'
 *     responses:
 *       201:
 *         description: Batch attestation created
 *       400:
 *         description: Validation error or no proof records found
 */
router.post('/batch', validateBody(BatchAttestationInputSchema), async (req, res, next) => {
  try {
    const { operator_id, period_start, period_end } = req.body;

    const proofRecords = await getProofRecordsByOperatorAndPeriod(
      operator_id,
      period_start,
      period_end
    );

    if (proofRecords.length === 0) {
      throw new AppError(400, 'No proof records found for the specified operator and period');
    }

    const attestation = await createBatchAttestation(
      operator_id,
      period_start,
      period_end,
      proofRecords
    );

    const output = formatBatchOutput(attestation);

    const response: ApiResponse<BatchAttestationOutput> = {
      success: true,
      data: output,
      error: null,
    };
    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/v1/attestations/{id}:
 *   get:
 *     summary: Get attestation by ID
 *     tags: [Attestations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Attestation found
 *       404:
 *         description: Attestation not found
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = paramAsString(req.params.id);
    const parseResult = UUIDSchema.safeParse(id);
    if (!parseResult.success) {
      throw new AppError(400, 'Invalid attestation ID format');
    }

    const attestation = await getAttestationById(id);
    if (!attestation) {
      throw new AppError(404, 'Attestation not found');
    }

    const response: ApiResponse<Attestation> = {
      success: true,
      data: attestation,
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/v1/attestations/operator/{operatorId}:
 *   get:
 *     summary: List attestations by operator
 *     tags: [Attestations]
 *     parameters:
 *       - in: path
 *         name: operatorId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Paginated list of attestations
 */
router.get('/operator/:operatorId', async (req, res, next) => {
  try {
    const operatorId = paramAsString(req.params.operatorId);
    const parseResult = OperatorIdSchema.safeParse(operatorId);
    if (!parseResult.success) {
      throw new AppError(400, 'Invalid operator ID format');
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

    const { attestations, total } = await getAttestationsByOperator(
      operatorId,
      page,
      limit
    );

    const response: PaginatedResponse<Attestation> = {
      success: true,
      data: attestations,
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      },
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/v1/attestations/{id}/output:
 *   get:
 *     summary: Get batch attestation output in standard format
 *     tags: [Attestations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Batch attestation output
 *       404:
 *         description: Attestation not found
 */
router.get('/:id/output', async (req, res, next) => {
  try {
    const id = paramAsString(req.params.id);
    const parseResult = UUIDSchema.safeParse(id);
    if (!parseResult.success) {
      throw new AppError(400, 'Invalid attestation ID format');
    }

    const attestation = await getAttestationById(id);
    if (!attestation) {
      throw new AppError(404, 'Attestation not found');
    }

    if (attestation.status !== 'completed') {
      throw new AppError(400, `Attestation is not completed. Current status: ${attestation.status}`);
    }

    const output = formatBatchOutput(attestation);
    const response: ApiResponse<BatchAttestationOutput> = {
      success: true,
      data: output,
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/v1/attestations/{id}/tx-signature:
 *   patch:
 *     summary: Store the on-chain transaction signature for an attestation
 *     tags: [Attestations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tx_signature]
 *             properties:
 *               tx_signature:
 *                 type: string
 *     responses:
 *       200:
 *         description: Transaction signature stored
 *       404:
 *         description: Attestation not found
 */
const TxSignatureSchema = z.object({
  tx_signature: z.string().min(32).max(128),
});

router.patch('/:id/tx-signature', validateBody(TxSignatureSchema), async (req, res, next) => {
  try {
    const id = paramAsString(req.params.id);
    const parseResult = UUIDSchema.safeParse(id);
    if (!parseResult.success) {
      throw new AppError(400, 'Invalid attestation ID format');
    }

    const { tx_signature } = req.body;
    const updated = await updateTxSignature(id, tx_signature);
    if (!updated) {
      throw new AppError(404, 'Attestation not found');
    }

    const response: ApiResponse<Attestation> = {
      success: true,
      data: updated,
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

export default router;
