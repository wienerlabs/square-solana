-- CreateEnum
CREATE TYPE "X402Network" AS ENUM ('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z');

-- AlterEnum
ALTER TYPE "ApiKeyScope" ADD VALUE 'x402:serve';

-- CreateTable
CREATE TABLE "x402_endpoints" (
    "id" UUID NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "path" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "amount" DECIMAL(20,0) NOT NULL,
    "mint" VARCHAR(44) NOT NULL,
    "network" "X402Network" NOT NULL,
    "pay_to" VARCHAR(44) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "x402_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x402_payments" (
    "id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "fingerprint" VARCHAR(69) NOT NULL,
    "transaction" VARCHAR(88) NOT NULL,
    "network" "X402Network" NOT NULL,
    "asset" VARCHAR(44) NOT NULL,
    "amount" DECIMAL(20,0) NOT NULL,
    "payer" VARCHAR(44) NOT NULL,
    "pay_to" VARCHAR(44) NOT NULL,
    "settled_at" TIMESTAMPTZ(3) NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "x402_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "x402_endpoints_wallet_path_key" ON "x402_endpoints"("wallet", "path");

-- CreateIndex
CREATE INDEX "x402_payments_endpoint_id_settled_at_idx" ON "x402_payments"("endpoint_id", "settled_at");

-- CreateIndex
CREATE UNIQUE INDEX "x402_payments_network_fingerprint_key" ON "x402_payments"("network", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "x402_payments_network_transaction_key" ON "x402_payments"("network", "transaction");

-- AddForeignKey
ALTER TABLE "x402_endpoints" ADD CONSTRAINT "x402_endpoints_wallet_fkey" FOREIGN KEY ("wallet") REFERENCES "users"("wallet") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "x402_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Biçim kısıtları: scripts/check-constraints.mjs çıktısı (Prisma şeması CHECK ifade edemez).
ALTER TABLE "x402_endpoints" ADD CONSTRAINT "x402_endpoints_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "x402_endpoints" ADD CONSTRAINT "x402_endpoints_amount_u64" CHECK ("amount" >= 0 AND "amount" <= 18446744073709551615);
ALTER TABLE "x402_endpoints" ADD CONSTRAINT "x402_endpoints_mint_address" CHECK ("mint" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "x402_endpoints" ADD CONSTRAINT "x402_endpoints_pay_to_address" CHECK ("pay_to" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_transaction_signature" CHECK ("transaction" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_asset_address" CHECK ("asset" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_amount_u64" CHECK ("amount" >= 0 AND "amount" <= 18446744073709551615);
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_payer_address" CHECK ("payer" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_pay_to_address" CHECK ("pay_to" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');

-- Ödeme tutarı sıfırdan büyüktür; yol '/' ile başlar ve sorgu içermez; ödeme yükü kimliği `paymentFingerprint`
-- biçimindedir (`svm:` ya da `json:` + SHA-256 hex).
ALTER TABLE "x402_endpoints" ADD CONSTRAINT "x402_endpoints_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "x402_endpoints" ADD CONSTRAINT "x402_endpoints_path_format" CHECK ("path" ~ '^/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*$');
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_fingerprint_format" CHECK ("fingerprint" ~ '^(svm|json):[0-9a-f]{64}$');
