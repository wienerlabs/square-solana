-- AlterEnum
ALTER TYPE "ApiKeyScope" ADD VALUE 'fiat:pay';

-- CreateEnum
CREATE TYPE "FiatPaymentSource" AS ENUM ('webhook', 'reconcile', 'mpp');

-- CreateEnum
CREATE TYPE "FiatPaymentVia" AS ENUM ('intent', 'mpp');

-- DropIndex
DROP INDEX "mpp_payments_job_idx";

-- AlterTable
ALTER TABLE "mpp_payments" ADD COLUMN     "amount" DECIMAL(20,0) NOT NULL,
ADD COLUMN     "authority" VARCHAR(44) NOT NULL,
ADD COLUMN     "source" "FiatPaymentSource" NOT NULL,
ALTER COLUMN "stripe_event_id" DROP NOT NULL,
ALTER COLUMN "institution" SET NOT NULL,
ALTER COLUMN "job" SET NOT NULL;

-- CreateTable
CREATE TABLE "fiat_payment_intents" (
    "payment_intent" TEXT NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "institution" VARCHAR(44) NOT NULL,
    "via" "FiatPaymentVia" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiat_payment_intents_pkey" PRIMARY KEY ("payment_intent")
);

-- CreateTable
CREATE TABLE "stripe_customers" (
    "institution" VARCHAR(44) NOT NULL,
    "customer" TEXT NOT NULL,
    "payment_method" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stripe_customers_pkey" PRIMARY KEY ("institution")
);

-- CreateIndex
CREATE INDEX "fiat_payment_intents_job_created_at_idx" ON "fiat_payment_intents"("job", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_customers_customer_key" ON "stripe_customers"("customer");

-- CreateIndex
CREATE UNIQUE INDEX "mpp_payments_job_key" ON "mpp_payments"("job");

-- Biçim kısıtları (scripts/check-constraints.mjs)
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_authority_address" CHECK ("authority" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_amount_u64" CHECK ("amount" >= 0 AND "amount" <= 18446744073709551615);
ALTER TABLE "fiat_payment_intents" ADD CONSTRAINT "fiat_payment_intents_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "fiat_payment_intents" ADD CONSTRAINT "fiat_payment_intents_institution_address" CHECK ("institution" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_institution_address" CHECK ("institution" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');

-- Stripe kimlikleri ve tutar
ALTER TABLE "fiat_payment_intents" ADD CONSTRAINT "fiat_payment_intents_amount_minor_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "fiat_payment_intents" ADD CONSTRAINT "fiat_payment_intents_payment_intent_stripe" CHECK ("payment_intent" ~ '^pi_[A-Za-z0-9]+$');
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_stripe_payment_intent_id_stripe" CHECK ("stripe_payment_intent_id" ~ '^pi_[A-Za-z0-9]+$');
ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_customer_stripe" CHECK ("customer" ~ '^cus_[A-Za-z0-9]+$');
ALTER TABLE "stripe_customers" ADD CONSTRAINT "stripe_customers_payment_method_stripe" CHECK ("payment_method" ~ '^pm_[A-Za-z0-9]+$');
