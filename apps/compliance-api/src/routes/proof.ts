import { Router } from 'express';
import { z } from 'zod';
import type { ApiResponse, ProofRecord } from '@aperture/types';
import { validateBody } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import {
  createProofRecord,
  getProofRecordById,
  getProofRecordByPaymentId,
  getProofRecordsByOperator,
  updateProofTxSignature,
} from '../models/proof-record.js';

const router = Router();

const ProofRecordInputSchema = z.object({
  operator_id: z.string().min(1).max(64),
  policy_id: z.string().min(1).max(64),
  payment_id: z.string().min(1),
  proof_hash: z.string().length(64),
  amount_range_min: z.number().nonnegative().finite(),
  amount_range_max: z.number().nonnegative().finite(),
  token_mint: z.string().min(1),
  is_compliant: z.boolean(),
  verified_at: z.coerce.date(),
}).refine(
  (data) => data.amount_range_max >= data.amount_range_min,
  { message: 'amount_range_max must be >= amount_range_min', path: ['amount_range_max'] }
);

const UUIDSchema = z.string().uuid();

function paramAsString(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @swagger
 * /api/v1/proofs:
 *   post:
 *     summary: Submit a new proof record
 *     tags: [Proofs]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProofRecordInput'
 *     responses:
 *       201:
 *         description: Proof record created
 *       400:
 *         description: Validation error
 *       409:
 *         description: Duplicate payment_id
 */
router.post('/', validateBody(ProofRecordInputSchema), async (req, res, next) => {
  try {
    const existing = await getProofRecordByPaymentId(req.body.payment_id);
    if (existing) {
      throw new AppError(409, `Proof record already exists for payment_id: ${req.body.payment_id}`);
    }

    const record = await createProofRecord(req.body);
    const response: ApiResponse<ProofRecord> = {
      success: true,
      data: record,
      error: null,
    };
    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/v1/proofs/{id}:
 *   get:
 *     summary: Get proof record by ID
 *     tags: [Proofs]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Proof record found
 *       404:
 *         description: Proof record not found
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = paramAsString(req.params.id);
    const parseResult = UUIDSchema.safeParse(id);
    if (!parseResult.success) {
      throw new AppError(400, 'Invalid proof record ID format');
    }

    const record = await getProofRecordById(id);
    if (!record) {
      throw new AppError(404, 'Proof record not found');
    }

    const response: ApiResponse<ProofRecord> = {
      success: true,
      data: record,
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/v1/proofs/operator/{operatorId}:
 *   get:
 *     summary: List proof records by operator
 *     tags: [Proofs]
 */
router.get('/operator/:operatorId', async (req, res, next) => {
  try {
    const operatorId = paramAsString(req.params.operatorId);
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

    const { records, total } = await getProofRecordsByOperator(operatorId, page, limit);

    res.json({
      success: true,
      data: records,
      pagination: { total, page, limit, total_pages: Math.ceil(total / limit) },
      error: null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/v1/proofs/payment/{paymentId}:
 *   get:
 *     summary: Get proof record by payment ID
 *     tags: [Proofs]
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Proof record found
 *       404:
 *         description: Proof record not found
 */
router.get('/payment/:paymentId', async (req, res, next) => {
  try {
    const paymentId = paramAsString(req.params.paymentId);
    const record = await getProofRecordByPaymentId(paymentId);
    if (!record) {
      throw new AppError(404, 'Proof record not found for this payment');
    }

    const response: ApiResponse<ProofRecord> = {
      success: true,
      data: record,
      error: null,
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

const TxSigSchema = z.object({ tx_signature: z.string().min(32).max(128) });

router.patch('/:id/tx-signature', validateBody(TxSigSchema), async (req, res, next) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const updated = await updateProofTxSignature(id, req.body.tx_signature);
    if (!updated) throw new AppError(404, 'Proof record not found');
    const response: ApiResponse<ProofRecord> = { success: true, data: updated, error: null };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

export default router;
