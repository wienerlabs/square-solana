-- CreateEnum
CREATE TYPE "ScreeningTrigger" AS ENUM ('request', 'renewal');

-- CreateEnum
CREATE TYPE "ScreeningOutcome" AS ENUM ('recorded', 'sourceError', 'txFailed');

-- CreateTable
CREATE TABLE "screening_decisions" (
    "id" UUID NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "trigger" "ScreeningTrigger" NOT NULL,
    "outcome" "ScreeningOutcome" NOT NULL,
    "status" "ScreeningStatus",
    "sources" JSONB NOT NULL,
    "evidence" JSONB,
    "source_hash" CHAR(64),
    "signature" VARCHAR(88),
    "slot" BIGINT,
    "screened_at" BIGINT,
    "expires_at" BIGINT,
    "error" TEXT,
    "caller" VARCHAR(16),
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screening_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "screening_decisions_wallet_at_idx" ON "screening_decisions"("wallet", "at");

-- CreateIndex
CREATE INDEX "screening_decisions_outcome_wallet_idx" ON "screening_decisions"("outcome", "wallet");

-- Biçim kısıtları: scripts/check-constraints.mjs çıktısı (Prisma şeması CHECK ifade edemez).
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_source_hash_hex32" CHECK ("source_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_signature_signature" CHECK ("signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');

-- Çağıran: API anahtarının SHA-256'sının ilk 16 hex karakteri.
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_caller_hex" CHECK ("caller" ~ '^[0-9a-f]{16}$');
-- Sonuca göre dolu ve boş alanlar: onaylanan kararda tx ve zincirdeki zamanlar, başarısız tx'te karar ve
-- sebep, kaynak hatasında yalnızca sebep.
ALTER TABLE "screening_decisions" ADD CONSTRAINT "screening_decisions_outcome_fields" CHECK (
  CASE "outcome"
    WHEN 'recorded' THEN "status" IS NOT NULL AND "evidence" IS NOT NULL AND "source_hash" IS NOT NULL
      AND "signature" IS NOT NULL AND "slot" IS NOT NULL AND "screened_at" IS NOT NULL AND "expires_at" IS NOT NULL
      AND "error" IS NULL
    WHEN 'txFailed' THEN "status" IS NOT NULL AND "evidence" IS NOT NULL AND "source_hash" IS NOT NULL
      AND "screened_at" IS NULL AND "expires_at" IS NULL AND "error" IS NOT NULL
    ELSE "status" IS NULL AND "evidence" IS NULL AND "source_hash" IS NULL AND "signature" IS NULL
      AND "slot" IS NULL AND "screened_at" IS NULL AND "expires_at" IS NULL AND "error" IS NOT NULL
  END
);
