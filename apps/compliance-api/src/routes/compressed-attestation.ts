import { Router } from 'express';
import { z } from 'zod';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { ApiResponse } from '@aperture/types';
import { validateBody } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
  getProofRecordById,
  updateCompressedTxSignature,
} from '../models/proof-record.js';

const router = Router();

const CompressAttestationSchema = z.object({
  proof_id: z.string().uuid(),
  recipient: z.string().min(32).max(64),
});

function isLightProtocolConfigured(): boolean {
  return Boolean(config.light.rpcUrl)
    && Boolean(config.light.compressedMint)
    && Boolean(config.light.payerPrivateKey);
}

function loadPayerKeypair(): Keypair {
  const raw = config.light.payerPrivateKey;
  const bytes = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(bytes);
}

/**
 * @swagger
 * /api/v1/compliance/compress-attestation:
 *   post:
 *     summary: Mint a compressed attestation token via Light Protocol
 *     tags: [Compliance]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [proof_id, recipient]
 *             properties:
 *               proof_id:
 *                 type: string
 *                 format: uuid
 *               recipient:
 *                 type: string
 *                 description: Solana wallet address to receive the compressed token
 *     responses:
 *       200:
 *         description: Compressed attestation minted
 *       400:
 *         description: Validation error or proof not compliant
 *       404:
 *         description: Proof record not found
 *       503:
 *         description: Light Protocol not configured
 */
router.post(
  '/compress-attestation',
  validateBody(CompressAttestationSchema),
  async (req, res, next) => {
    try {
      if (!isLightProtocolConfigured()) {
        throw new AppError(
          503,
          'Light Protocol is not configured. Set LIGHT_RPC_URL, COMPRESSED_ATTESTATION_MINT, and LIGHT_PAYER_PRIVATE_KEY.'
        );
      }

      const { proof_id, recipient } = req.body as z.infer<typeof CompressAttestationSchema>;

      const proof = await getProofRecordById(proof_id);
      if (!proof) {
        throw new AppError(404, `Proof record not found: ${proof_id}`);
      }

      if (!proof.is_compliant) {
        throw new AppError(400, 'Cannot mint compressed attestation for non-compliant proof');
      }

      if (proof.compressed_tx_signature) {
        const response: ApiResponse<{ tx_signature: string; proof_id: string }> = {
          success: true,
          data: {
            tx_signature: proof.compressed_tx_signature,
            proof_id: proof.id,
          },
          error: null,
        };
        res.json(response);
        return;
      }

      // Validate recipient address
      let recipientPubkey: PublicKey;
      try {
        recipientPubkey = new PublicKey(recipient);
      } catch {
        throw new AppError(400, 'Invalid recipient Solana address');
      }

      // Dynamic import to avoid loading Light SDK when not configured
      const { createRpc } = await import('@lightprotocol/stateless.js');
      const { mintTo } = await import('@lightprotocol/compressed-token');

      const rpc = createRpc(config.light.rpcUrl, config.light.rpcUrl);
      const payer = loadPayerKeypair();
      const mint = new PublicKey(config.light.compressedMint);

      logger.info('Minting compressed attestation', {
        proof_id,
        recipient,
        mint: mint.toBase58(),
      });

      const txSignature = await mintTo(
        rpc,
        payer,
        mint,
        recipientPubkey,
        payer,
        1
      );

      const updated = await updateCompressedTxSignature(proof_id, txSignature);

      logger.info('Compressed attestation minted', {
        proof_id,
        tx_signature: txSignature,
      });

      const response: ApiResponse<{
        tx_signature: string;
        proof_id: string;
        mint: string;
        recipient: string;
      }> = {
        success: true,
        data: {
          tx_signature: txSignature,
          proof_id: updated?.id ?? proof_id,
          mint: mint.toBase58(),
          recipient: recipientPubkey.toBase58(),
        },
        error: null,
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /api/v1/compliance/light-status:
 *   get:
 *     summary: Check Light Protocol configuration status
 *     tags: [Compliance]
 *     responses:
 *       200:
 *         description: Light Protocol status
 */
router.get('/light-status', (_req, res) => {
  const configured = isLightProtocolConfigured();
  res.json({
    success: true,
    data: {
      configured,
      rpc_url: configured ? config.light.rpcUrl : null,
      compressed_mint: configured ? config.light.compressedMint : null,
    },
    error: null,
  });
});

export default router;
