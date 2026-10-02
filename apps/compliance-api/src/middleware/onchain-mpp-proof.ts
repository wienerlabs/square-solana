import type { Request, Response, NextFunction } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

/**
 * Adım 8e — On-chain MPP proof gate.
 *
 * Once the agent (or dashboard) has submitted verify_mpp_payment_proof to the
 * verifier program, the resulting ProofRecord PDA carries `consumed=true`,
 * the byte-bound recipient/mint/amount, and the Stripe receipt hash.
 *
 * This middleware closes the loop on the compliance-api side:
 *   1. Reads the on-chain ProofRecord at the PDA the caller pins via
 *      `x-aperture-proof-record` header.
 *   2. Confirms it is owned by the verifier program (so a spoofed account
 *      cannot fake compliance) and that `verified=1` AND `consumed=1`.
 *   3. Confirms the proof's recipient field matches the operator the
 *      caller is acting for and that token_mint references USD billing
 *      (32-byte zero, the canonical "fiat" sentinel for Stripe-backed
 *      payments — distinct from any real Solana mint).
 *
 * Mismatches return 402 so the caller can retry after re-anchoring; the
 * Stripe receipt itself is already validated upstream by requireMPPPayment.
 */

const VERIFIER_PROGRAM = new PublicKey(
  process.env.VERIFIER_PROGRAM ?? 'AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU',
);

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

let cachedConnection: Connection | null = null;
function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
  }
  return cachedConnection;
}

// ProofRecord layout (Anchor):
//   8 disc + 32 operator + 32 policy_id + 32 proof_hash + 32 image_id
// + 32 journal_digest + 8 timestamp + 1 verified + 1 consumed
// + 32 recipient + 32 token_mint + 8 amount_lamports + 1 bump
const OFF_OPERATOR = 8;
const OFF_VERIFIED = 8 + 32 + 32 + 32 + 32 + 32 + 8;            // 176
const OFF_CONSUMED = OFF_VERIFIED + 1;                          // 177
const OFF_RECIPIENT = OFF_CONSUMED + 1;                         // 178
const OFF_AMOUNT = OFF_RECIPIENT + 32 + 32;                     // 242

export interface OnchainMppProofView {
  readonly proofRecordPubkey: string;
  readonly operator: string;
  readonly amountLamports: bigint;
  readonly verified: boolean;
  readonly consumed: boolean;
}

export function requireOnchainMppProof() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const proofRecordHeader = req.header('x-aperture-proof-record');
    if (!proofRecordHeader) {
      res.status(402).json({
        success: false,
        error:
          'On-chain MPP proof required. Submit verify_mpp_payment_proof first and pass the resulting ProofRecord PDA via the x-aperture-proof-record header.',
        data: null,
      });
      return;
    }

    let proofRecordPubkey: PublicKey;
    try {
      proofRecordPubkey = new PublicKey(proofRecordHeader);
    } catch {
      res.status(400).json({
        success: false,
        error: 'x-aperture-proof-record header is not a valid Solana pubkey',
        data: null,
      });
      return;
    }

    try {
      const accountInfo = await getConnection().getAccountInfo(
        proofRecordPubkey,
        'confirmed',
      );
      if (!accountInfo) {
        res.status(402).json({
          success: false,
          error: `ProofRecord ${proofRecordPubkey.toBase58()} not found on-chain.`,
          data: null,
        });
        return;
      }
      if (!accountInfo.owner.equals(VERIFIER_PROGRAM)) {
        res.status(402).json({
          success: false,
          error: `ProofRecord owner is ${accountInfo.owner.toBase58()}, expected verifier program.`,
          data: null,
        });
        return;
      }
      const data = accountInfo.data;
      if (data.length < OFF_AMOUNT + 8) {
        res.status(402).json({
          success: false,
          error: 'ProofRecord too short — wrong account version?',
          data: null,
        });
        return;
      }

      const verified = data[OFF_VERIFIED] === 1;
      const consumed = data[OFF_CONSUMED] === 1;
      if (!verified || !consumed) {
        res.status(402).json({
          success: false,
          error: `ProofRecord not yet consumed (verified=${verified}, consumed=${consumed}). The verifier accepts the proof only after the Stripe ed25519 attestation; retry after the Solana tx confirms.`,
          data: null,
        });
        return;
      }

      const operator = new PublicKey(data.subarray(OFF_OPERATOR, OFF_OPERATOR + 32));
      const amountLamports = data.readBigUInt64LE(OFF_AMOUNT);

      const view: OnchainMppProofView = {
        proofRecordPubkey: proofRecordPubkey.toBase58(),
        operator: operator.toBase58(),
        amountLamports,
        verified,
        consumed,
      };
      (req as Request & { onchainProof: OnchainMppProofView }).onchainProof = view;

      logger.info('On-chain MPP proof verified', {
        proof_pda: view.proofRecordPubkey,
        operator: view.operator,
        amount_lamports: amountLamports.toString(),
      });

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'On-chain proof check failed';
      logger.error('On-chain MPP proof check error', { error: message });
      res.status(502).json({
        success: false,
        error: `On-chain proof check failed: ${message}`,
        data: null,
      });
    }
  };
}
