-- CreateEnum
CREATE TYPE "SponsoredTxStatus" AS ENUM ('signed', 'submitted', 'failed');

-- CreateTable
CREATE TABLE "sponsored_txs" (
    "id" UUID NOT NULL,
    "signature" VARCHAR(88) NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "api_key_id" UUID,
    "status" "SponsoredTxStatus" NOT NULL,
    "fee_lamports" DECIMAL(20,0) NOT NULL,
    "rent_lamports" DECIMAL(20,0) NOT NULL,
    "compute_units" INTEGER,
    "compute_unit_limit" INTEGER NOT NULL,
    "compute_unit_price" DECIMAL(20,0) NOT NULL,
    "instructions" TEXT[],
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sponsored_txs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sponsored_txs_signature_key" ON "sponsored_txs"("signature");

-- CreateIndex
CREATE INDEX "sponsored_txs_wallet_created_at_idx" ON "sponsored_txs"("wallet", "created_at");

-- CreateIndex
CREATE INDEX "sponsored_txs_created_at_idx" ON "sponsored_txs"("created_at");

-- Biçim kısıtları: scripts/check-constraints.mjs çıktısı (Prisma şeması CHECK ifade edemez).
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_signature_signature" CHECK ("signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_fee_lamports_u64" CHECK ("fee_lamports" >= 0 AND "fee_lamports" <= 18446744073709551615);
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_rent_lamports_u64" CHECK ("rent_lamports" >= 0 AND "rent_lamports" <= 18446744073709551615);
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_compute_unit_price_u64" CHECK ("compute_unit_price" >= 0 AND "compute_unit_price" <= 18446744073709551615);

-- Sayaç aralıkları: compute unit tx tavanını (1 400 000) aşamaz.
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_compute_units_range" CHECK ("compute_units" IS NULL OR ("compute_units" >= 0 AND "compute_units" <= 1400000));
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_compute_unit_limit_range" CHECK ("compute_unit_limit" >= 0 AND "compute_unit_limit" <= 1400000);
-- Başarısız gönderimde hata vardır, diğerlerinde yoktur.
ALTER TABLE "sponsored_txs" ADD CONSTRAINT "sponsored_txs_status_error" CHECK (("status" = 'failed') = ("error" IS NOT NULL));
