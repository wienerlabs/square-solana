# Fiat ödeme devnet kabul koşusu (BE-25)

**Issue:** BE-25 (#80) · **Karar:** [ADR 0026](../decisions/0026-stripe-mpp-fiat-odemesi.md), zincir tarafı
[ADR 0024](../decisions/0024-stripe-mpp-fiat-rayi.md) · **Test:**
[`apps/api/test/fiat-devnet.e2e.test.ts`](../../apps/api/test/fiat-devnet.e2e.test.ts)

Kabul kriteri: "Stripe test modunda ödeme → on-chain MPP ispatı kabul". Koşu gerçek Stripe test modu ve devnet
programlarıyla yapıldı. API testte açıldı, kurumu gerçek indexer süreci aynaladı ve ispatı yerelde çalışan prover
servisi üretti.

| Alan | Değer |
|---|---|
| Tarih (UTC) | 2026-10-07 |
| Commit | `5b6f5d3` (`feat/be-25-stripe-mpp`) |
| Küme | devnet, `https://api.devnet.solana.com` |
| Programlar | [deploy kaydındaki](devnet.md) v0.7.0 (BC-37) |
| Stripe | Square'in Stripe hesabı, test modu |
| MPP authority | `CPwxS6VAy25B9xFKGKjNkXBmFcztNDea68J76SDeTn6c` (`VerifierConfig.mpp_authority`; API'nin `GET /v1/fiat/config`'iyle aynı) |
| Prover | `apps/prover` yerelde, artefakt `008adfb1…` (devnet verifier'ının gömülü anahtarı); ispat 707 ms, ret kodu 0 |
| Ücret ödeyen | deployer `3qJFqe1Y…` |

## Roller

| Rol | Adres |
|---|---|
| Kurum (imzacı, `Job.institution`) | `7xNWRmEbp5aQFQuL1vAnJAW3iZn6NXA3CisMSAmnXoi4` |
| Kurum (`Institution` PDA) | `D63bxx4kE8SV2J69AewnitGVLNY5QUXw5RfkUKWSag37` |
| Politika | `5idW2uWTehU12r7VuvVyJNEcXazsMVyfsBPL6kw2st7J` ([CLI koşusundaki](cli-devnet.md) politika) |
| Agent kaydı / cüzdanı | `3vr5eQXmTA9Lpy7EDkUeG9EWbQkAJjdLBeVwo3uTNRBX` / `C6iFdvJpk2bbFKTseNGhgdKuPZjWpV762b5wuW7AX1z4` |

## Adımlar

Job `4jFcA9uDB5n1xM8F7nT1w6B1jFoLkGazrfbjUnVrrD1S`, fiat rayı, 1 USD (1 000 000 USDC birimi = 100 sent).

| # | Adım | İmza / sonuç |
|---|---|---|
| 1 | `create_fiat_job` (kurum) | `4ezM7q3M4AA6yjJBZ4cTWu4iXY6QQ9fYw5UNVTC1nRpxRgQhUsgPjgbCcXb763vDjjCWravVRJ7PZ4Ari16GCPau` |
| 2 | `accept_job` (agent) | `4tuKTRTEgxmVNvjpoACt2MJNS2cadMCfdC6AcxLPVofKCw6mhLiFQqUWH2gHoXxeFdtApjqPSbyqBqZ7qkWgeyA6` |
| 3 | `submit_work` (agent) | `3Jz7zAEbEnmKb2fm4xYcDy4iN6YjMJwfFEetSikDTVQWb1y38aQGBMWxJghQNu3dCVhzeQhwpSgu1qyq4bfd3mGY` |
| 4 | `createFiatPayment` (kurumun oturumu) | PaymentIntent `pi_3UNkctDEQ17rsxFG1dZsXly6`, 100 sent |
| 5 | Test kartıyla onay (Stripe.js'in `confirmCardPayment`'ı) | `succeeded` |
| 6 | `reconcileFiatPayment` | attestation (kaynak `reconcile`): makbuz commitment'ı `122a7aa24c49b9e6d63efea1b9aeda95a8a3c2514a918ff4efd3797cedbee528`, imza `41i71bdWdHfjSJ1xd7pxrdkcVNVbcP8Wc86TZq3FaP1rTCjasQ3unykhZwoV1GxUJcLkefjTWvLCHc6QtptymFxL` |
| 7 | İspat (`stripeReceiptHash` = commitment) ve `verify_mpp_payment_proof` (Ed25519 attestation talimatıyla) | `3eNR6DBMfiVWaoxCossHxnW2sNAdtyfNEWGJFe7ceSdMMsN1rzKGNX5XzC5e6AoDMA4xjA2ndNF9EdVbdgK4CGJd`; `ReleaseProof` `Compliant` |
| 8 | `finalize_fiat_payment` (permissionless) | `4cD3XRfmDxobHCj4gSEmb2DcnbWLBo8Nx4USNbEqsDDmFZ5CVcfotERvfgNBnqtdGJwNDuz14mue8bGAKzCMDXei`; job `Released`, `ValidationRecord` yazıldı |

- **Webhook:** Stripe'ın webhook'u yerel API'ye ulaşmaz; ödeme mutabakat ucuyla (PaymentIntent Stripe'tan okunarak)
  attest edildi. Webhook'un imza, zaman damgası ve tekrar kuralları `apps/api/test/fiat.test.ts`'te Stripe'ın imza
  biçimiyle (`generateTestHeaderString`) denetlenir.
- **MPP (402):** Stripe profili hesabın canlı aktivasyonunu istediği için koşuda yoktu (test atlandı). MPP yolu
  `fiat.test.ts`'te gerçek `mppx/client`'la uçtan uca denenir. Profil verildiğinde aynı test `FIAT_E2E_NETWORK_ID`
  ile ikinci işi MPP'yle öder.
- **İlk deneme:** Aynı koşu önce job `9s1gEZgr7PyhjDhR4oUvhHpcCRyyc5yyjgQF44SLy4JW` ile başladı. Ödeme ve attestation
  tamamlandı; ispat adımı yerel prover'ın API anahtarı özeti yanlış kurulduğu için `unauthorized` aldı. Job
  `Delivered`'da kaldı, ödemesi test modundadır.

## Yeniden koşmak

```bash
pnpm turbo build --filter @squaresdk/solana-api... --filter @squaresdk/solana-indexer
# apps/prover yerelde (PROVER_API_KEY_SHA256 = anahtarın SHA-256'sı)
FIAT_E2E_INSTITUTION=<kurum keypair'i> FIAT_E2E_AGENT=<agent keypair'i> FIAT_E2E_AGENT_RECORD=<kayıt> \
FIAT_E2E_POLICY=<politika> FIAT_E2E_POLICY_DOCUMENT=<belge> FIAT_E2E_POLICY_SECRET=<sır dosyası> \
FIAT_E2E_FEE_PAYER=<keypair> FIAT_E2E_MPP_AUTHORITY=<mpp authority keypair'i> \
FIAT_E2E_STRIPE_SECRET_KEY=<sk_test_…> FIAT_E2E_STRIPE_PUBLISHABLE_KEY=<pk_test_…> \
FIAT_E2E_PROVER_URL=<prover> FIAT_E2E_PROVER_API_KEY=<anahtar> FIAT_E2E_ARTIFACT_VERSION=<zkey SHA-256> \
  pnpm --filter @squaresdk/solana-api exec vitest run test/fiat-devnet.e2e.test.ts
```
