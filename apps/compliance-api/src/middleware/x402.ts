import type { Request, Response, NextFunction } from 'express';
import { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const USDC_MINT = process.env.USDC_MINT_ADDRESS ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PUBLISHER_WALLET = process.env.PUBLISHER_WALLET ?? 'CBDjvUkZZ6ucrVGrU3vRraasTytha8oVg2NLCxAHE25b';

export interface X402PaymentRequirement {
  readonly version: '1';
  readonly scheme: 'exact';
  readonly network: 'solana-devnet';
  readonly token: string;
  readonly amount: string;
  readonly recipient: string;
  readonly description: string;
  readonly resource: string;
}

export interface X402PaymentProof {
  readonly txSignature: string;
  readonly zkProofHash?: string;
  readonly payer: string;
}

/**
 * x402 payment middleware.
 * If x-402-payment header is present, verifies the payment on-chain.
 * If not, returns 402 with payment requirements.
 */
export function requireX402Payment(
  priceLamports: number,
  description: string
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentHeader = req.headers['x-402-payment'] as string | undefined;

    if (!paymentHeader) {
      // No payment -- return 402 with payment requirements
      const requirement: X402PaymentRequirement = {
        version: '1',
        scheme: 'exact',
        network: 'solana-devnet',
        token: USDC_MINT,
        amount: String(priceLamports),
        recipient: PUBLISHER_WALLET,
        description,
        resource: req.originalUrl,
      };

      res.status(402).json({
        success: false,
        error: 'Payment Required',
        data: null,
        paymentRequirement: requirement,
      });
      return;
    }

    // Payment header present -- verify on-chain
    try {
      const proof: X402PaymentProof = JSON.parse(
        Buffer.from(paymentHeader, 'base64').toString('utf-8')
      );

      if (!proof.txSignature || !proof.payer) {
        res.status(400).json({
          success: false,
          error: 'Invalid x-402-payment header: missing txSignature or payer',
          data: null,
        });
        return;
      }

      // Verify transaction on-chain
      const connection = new Connection(SOLANA_RPC, 'confirmed');
      const txInfo = await connection.getTransaction(proof.txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!txInfo) {
        res.status(402).json({
          success: false,
          error: 'Transaction not found on-chain. It may not be confirmed yet.',
          data: null,
        });
        return;
      }

      if (txInfo.meta?.err) {
        res.status(402).json({
          success: false,
          error: `Transaction failed on-chain: ${JSON.stringify(txInfo.meta.err)}`,
          data: null,
        });
        return;
      }

      // Attach payment proof to request for downstream handlers
      (req as Request & { x402Payment: X402PaymentProof }).x402Payment = proof;

      logger.info('x402 payment verified', {
        txSignature: proof.txSignature,
        payer: proof.payer,
        resource: req.originalUrl,
      });

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Payment verification failed';
      logger.error('x402 payment verification error', { error: message });
      res.status(402).json({
        success: false,
        error: `Payment verification failed: ${message}`,
        data: null,
      });
    }
  };
}
