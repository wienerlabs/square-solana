import type { Request, Response, NextFunction } from 'express';
import { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
// Production x402 advertises USDC (Circle's devnet/mainnet stablecoin) as
// the default payment rail. Compliance is enforced at the Anchor program
// level via verify_payment_proof_v2_with_transfer (ZK proof + atomic
// recipient/mint/amount byte-binding) and at the API level via the
// ProofRecord PDA lookup downstream — neither path needs a Token-2022
// transfer hook on the mint, which is why aUSDC is no longer the default.
// Operators can override via PAYMENT_MINT_ADDRESS for USDT or any other
// SPL token; legacy AUSDC_MINT_ADDRESS / VUSDC_MINT_ADDRESS env values
// are still accepted as a backwards-compatible fallback.
const PAYMENT_MINT =
  process.env.PAYMENT_MINT_ADDRESS ??
  process.env.USDC_MINT_ADDRESS ??
  process.env.AUSDC_MINT_ADDRESS ??
  process.env.VUSDC_MINT_ADDRESS ??
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
// Treasury wallet that receives x402 aUSDC payments. MUST be different
// from the paying operator wallet — otherwise transfers are self-transfers
// and the operator's net aUSDC balance never moves. Pre-generated keypair
// lives at scripts/deploy/aperture-treasury.json; only the pubkey is
// surfaced here.
const PUBLISHER_WALLET =
  process.env.PUBLISHER_WALLET ?? 'GRyQkYHeqEYT9KmANxAA9mtw6iJoqCtxVNCNRQD8PrMq';

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
        token: PAYMENT_MINT,
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

      // Verify transaction on-chain with retries. Public devnet RPC
      // occasionally fails transient fetches and a freshly-submitted tx may
      // not have been indexed yet — both look identical to a missing tx, so
      // we poll for up to ~12s before giving up.
      const connection = new Connection(SOLANA_RPC, 'confirmed');
      let txInfo: Awaited<ReturnType<typeof connection.getTransaction>> = null;
      let lastFetchError: unknown = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          txInfo = await connection.getTransaction(proof.txSignature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          if (txInfo) break;
        } catch (fetchErr) {
          lastFetchError = fetchErr;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (!txInfo) {
        const hint = lastFetchError instanceof Error ? lastFetchError.message : 'not confirmed yet';
        res.status(402).json({
          success: false,
          error: `Transaction ${proof.txSignature.slice(0, 12)}... not found on-chain: ${hint}`,
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
