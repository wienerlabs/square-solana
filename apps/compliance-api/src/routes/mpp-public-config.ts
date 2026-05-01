import { Router } from 'express';
import type { ApiResponse } from '@aperture/types';
import { config } from '../config.js';
import { getAuthorityPublicKeyBase58 } from '../utils/stripe-receipt.js';

const router = Router();

/**
 * Public, non-authenticated configuration the dashboard needs to drive the
 * MPP B-flow card on PaymentsTab. None of the fields are secret:
 *   - publishableKey: Stripe pk_test/pk_live, designed for browser exposure.
 *   - mppAuthorityPubkey: the verifier's hardcoded ed25519 signer.
 *
 * Returning `null` for fields that are not configured (rather than a 503)
 * lets the dashboard render the rest of the page and only hide the MPP UI
 * when the operator hasn't provisioned Stripe yet.
 */
interface MppPublicConfigResponse {
  readonly stripe: {
    readonly publishableKey: string | null;
    /// True when the publishable key starts with pk_test_; the dashboard
    /// uses this to build /test/payments/... URLs that point to Stripe's
    /// sandbox dashboard.
    readonly isTestMode: boolean;
  };
  readonly mppAuthorityPubkey: string | null;
}

router.get('/mpp/public-config', (_req, res) => {
  let mppAuthorityPubkey: string | null = null;
  try {
    mppAuthorityPubkey = config.mppAuthority.keypairBase58
      ? getAuthorityPublicKeyBase58()
      : null;
  } catch {
    mppAuthorityPubkey = null;
  }

  const publishableKey = config.stripe.publishableKey || null;
  const isTestMode = publishableKey?.startsWith('pk_test_') ?? true;

  const response: ApiResponse<MppPublicConfigResponse> = {
    success: true,
    data: {
      stripe: {
        publishableKey,
        isTestMode,
      },
      mppAuthorityPubkey,
    },
    error: null,
  };
  res.json(response);
});

export default router;
