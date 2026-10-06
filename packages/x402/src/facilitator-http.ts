// Kendi facilitator'ımızı başka servislere x402 facilitator HTTP API'siyle açar (`POST /verify`,
// `POST /settle`, `GET /supported`); karşı taraf `createFacilitatorClient({ mode: 'remote' })` ya da resmi
// `HTTPFacilitatorClient` kullanır. Uzlaştırma ücret ödeyen cüzdandan SOL harcadığı için her istek bearer
// belirteci taşımalıdır; uç herkese açık bırakılmaz (ADR 0018).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FacilitatorClient } from '@x402/core/server';
import { isPaymentPayloadV2, isPaymentRequirementsV2 } from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import express, { type Request, type Response, type Router } from 'express';

export interface FacilitatorRouterOptions {
  readonly facilitator: FacilitatorClient;
  /** Çağıranların `Authorization: Bearer <token>` ile göndereceği belirteç; en az 32 karakter. */
  readonly authToken: string;
  /** Doğrulama ya da uzlaştırma hatası (beklenmeyen istisna) için gözlem kancası. */
  readonly onError?: (operation: 'verify' | 'settle' | 'supported', error: unknown) => void;
}

const MIN_TOKEN_LENGTH = 32;
const digest = (value: string) => createHash('sha256').update(value).digest();

export function createFacilitatorRouter(options: FacilitatorRouterOptions): Router {
  if (options.authToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`facilitator belirteci en az ${MIN_TOKEN_LENGTH} karakter olmalı`);
  }
  const expected = digest(`Bearer ${options.authToken}`);
  const router = express.Router();

  router.use((req, res, next) => {
    const presented = req.header('authorization') ?? '';
    if (!timingSafeEqual(digest(presented), expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  const body = (req: Request): { payload: PaymentPayload; requirements: PaymentRequirements } | null => {
    const { paymentPayload, paymentRequirements } = (req.body ?? {}) as Record<string, unknown>;
    if (!isPaymentPayloadV2(paymentPayload) || !isPaymentRequirementsV2(paymentRequirements)) return null;
    // Şema ağı düz metin olarak doğrular; CAIP-2 biçimini facilitator denetler.
    return { payload: paymentPayload as PaymentPayload, requirements: paymentRequirements as PaymentRequirements };
  };
  const fail = (res: Response, operation: 'verify' | 'settle', error: unknown) => {
    options.onError?.(operation, error);
    const message = error instanceof Error ? error.message : String(error);
    if (operation === 'verify')
      res.status(500).json({ isValid: false, invalidReason: 'unexpected_verify_error', invalidMessage: message });
    else
      res.status(500).json({
        success: false,
        errorReason: 'unexpected_settle_error',
        errorMessage: message,
        transaction: '',
        network: '',
      });
  };

  router.post('/verify', express.json({ limit: '64kb' }), async (req, res) => {
    const input = body(req);
    if (!input) {
      res.status(400).json({
        isValid: false,
        invalidReason: 'invalid_payload',
        invalidMessage: 'x402 v2 paymentPayload ve paymentRequirements gerekli',
      });
      return;
    }
    try {
      res.json(await options.facilitator.verify(input.payload, input.requirements));
    } catch (error) {
      fail(res, 'verify', error);
    }
  });

  router.post('/settle', express.json({ limit: '64kb' }), async (req, res) => {
    const input = body(req);
    if (!input) {
      res.status(400).json({
        success: false,
        errorReason: 'invalid_payload',
        errorMessage: 'x402 v2 paymentPayload ve paymentRequirements gerekli',
        transaction: '',
        network: '',
      });
      return;
    }
    try {
      res.json(await options.facilitator.settle(input.payload, input.requirements));
    } catch (error) {
      fail(res, 'settle', error);
    }
  });

  router.get('/supported', async (_req, res) => {
    try {
      res.json(await options.facilitator.getSupported());
    } catch (error) {
      options.onError?.('supported', error);
      res.status(500).json({ error: 'supported_unavailable' });
    }
  });

  return router;
}
