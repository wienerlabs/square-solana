-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProgramName" AS ENUM ('registry', 'policy', 'verifier', 'escrow');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('active', 'inactive', 'deregistered');

-- CreateEnum
CREATE TYPE "AgentCardSource" AS ENUM ('hosted', 'fetched');

-- CreateEnum
CREATE TYPE "ScreeningStatus" AS ENUM ('clear', 'flagged');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('open', 'funded', 'accepted', 'delivered', 'disputed', 'resolved', 'released', 'refunded', 'cancelled');

-- CreateEnum
CREATE TYPE "DisputeResolution" AS ENUM ('pending', 'favorAgent', 'favorInstitution', 'split');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('listed', 'bought', 'settled', 'defaulted');

-- CreateEnum
CREATE TYPE "ValidationOutcome" AS ENUM ('verified', 'refused', 'noGate', 'noPayout');

-- CreateEnum
CREATE TYPE "ReleaseVerdict" AS ENUM ('compliant', 'refused');

-- CreateEnum
CREATE TYPE "KeeperActionKind" AS ENUM ('finalizePayment', 'executeResolution', 'lapseDispute');

-- CreateEnum
CREATE TYPE "KeeperOutcome" AS ENUM ('submitted', 'confirmed', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "KeeperReason" AS ENUM ('challengeOpen', 'proofRequired', 'staleProof', 'screeningPending', 'unprofitable', 'rpcError', 'programError');

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('read', 'tx:prepare', 'deliveries:write', 'agents:write', 'prove');

-- CreateEnum
CREATE TYPE "CctpTransferStatus" AS ENUM ('pendingAttestation', 'attested', 'received', 'funded', 'failed');

-- CreateTable
CREATE TABLE "programs" (
    "name" "ProgramName" NOT NULL,
    "program_id" VARCHAR(44) NOT NULL,
    "idl_version" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "indexer_cursors" (
    "program" "ProgramName" NOT NULL,
    "last_slot" BIGINT NOT NULL,
    "last_signature" VARCHAR(88) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "indexer_cursors_pkey" PRIMARY KEY ("program")
);

-- CreateTable
CREATE TABLE "chain_events" (
    "id" BIGSERIAL NOT NULL,
    "signature" VARCHAR(88) NOT NULL,
    "slot" BIGINT NOT NULL,
    "block_time" BIGINT,
    "instruction_index" INTEGER NOT NULL,
    "event_index" INTEGER NOT NULL,
    "program" "ProgramName" NOT NULL,
    "name" TEXT NOT NULL,
    "job" VARCHAR(44),
    "payload" JSONB NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institutions" (
    "address" VARCHAR(44) NOT NULL,
    "owner_key" VARCHAR(44) NOT NULL,
    "multisig_vault" VARCHAR(44),
    "name" TEXT NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "policies" (
    "address" VARCHAR(44) NOT NULL,
    "institution" VARCHAR(44) NOT NULL,
    "policy_id" CHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "policy_metas" (
    "policy" VARCHAR(44) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000),
    "labels" VARCHAR(40)[],
    "updated_by" VARCHAR(44) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "policy_metas_pkey" PRIMARY KEY ("policy")
);

-- CreateTable
CREATE TABLE "agents" (
    "address" VARCHAR(44) NOT NULL,
    "creator" VARCHAR(44) NOT NULL,
    "owner" VARCHAR(44) NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "agent_id" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL,
    "agent_card_uri" TEXT NOT NULL,
    "agent_card_hash" CHAR(64) NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "agent_cards" (
    "agent_record" VARCHAR(44) NOT NULL,
    "source" "AgentCardSource" NOT NULL,
    "uri" TEXT NOT NULL,
    "raw" BYTEA NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "content" JSONB NOT NULL,
    "skills" TEXT[],
    "verified" BOOLEAN NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_cards_pkey" PRIMARY KEY ("agent_record")
);

-- CreateTable
CREATE TABLE "screenings" (
    "address" VARCHAR(44) NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "status" "ScreeningStatus" NOT NULL,
    "screened_at" BIGINT NOT NULL,
    "expires_at" BIGINT NOT NULL,
    "source_hash" CHAR(64) NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "screenings_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "jobs" (
    "address" VARCHAR(44) NOT NULL,
    "institution" VARCHAR(44) NOT NULL,
    "agent_record" VARCHAR(44) NOT NULL,
    "agent_wallet" VARCHAR(44) NOT NULL,
    "policy" VARCHAR(44),
    "mint" VARCHAR(44) NOT NULL,
    "amount" DECIMAL(20,0) NOT NULL,
    "spec_hash" CHAR(64) NOT NULL,
    "status" "JobStatus" NOT NULL,
    "created_at" BIGINT NOT NULL,
    "deadline" BIGINT NOT NULL,
    "challenge_end" BIGINT NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_slot" BIGINT,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "disputes" (
    "job" VARCHAR(44) NOT NULL,
    "institution" VARCHAR(44) NOT NULL,
    "agent_record" VARCHAR(44) NOT NULL,
    "job_status" "JobStatus" NOT NULL,
    "challenger" VARCHAR(44) NOT NULL,
    "bond" DECIMAL(20,0) NOT NULL,
    "reason_hash" CHAR(64) NOT NULL,
    "raised_at" BIGINT NOT NULL,
    "deadline" BIGINT NOT NULL,
    "resolution" "DisputeResolution" NOT NULL,
    "lapsed" BOOLEAN NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("job")
);

-- CreateTable
CREATE TABLE "claims" (
    "address" VARCHAR(44) NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "seller" VARCHAR(44) NOT NULL,
    "buyer" VARCHAR(44),
    "status" "ClaimStatus" NOT NULL,
    "price" DECIMAL(20,0) NOT NULL,
    "face_value" DECIMAL(20,0) NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_slot" BIGINT,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "agent_reputations" (
    "address" VARCHAR(44) NOT NULL,
    "agent_record" VARCHAR(44) NOT NULL,
    "jobs_completed" DECIMAL(20,0) NOT NULL,
    "total_earned" DECIMAL(20,0) NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_reputations_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "validation_records" (
    "address" VARCHAR(44) NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "agent_record" VARCHAR(44) NOT NULL,
    "outcome" "ValidationOutcome" NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "validation_records_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "release_proofs" (
    "address" VARCHAR(44) NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "institution" VARCHAR(44) NOT NULL,
    "policy" VARCHAR(44) NOT NULL,
    "payee" VARCHAR(44) NOT NULL,
    "verdict" "ReleaseVerdict" NOT NULL,
    "refusal_code" INTEGER NOT NULL,
    "consumed" BOOLEAN NOT NULL,
    "net_amount" DECIMAL(20,0) NOT NULL,
    "proof_timestamp" BIGINT NOT NULL,
    "account" JSONB NOT NULL,
    "slot" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "release_proofs_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "work_hash" CHAR(64) NOT NULL,
    "delivery_uri" VARCHAR(128) NOT NULL,
    "content_type" VARCHAR(120) NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by" VARCHAR(44) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keeper_actions" (
    "id" UUID NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "action" "KeeperActionKind" NOT NULL,
    "outcome" "KeeperOutcome" NOT NULL,
    "reason" "KeeperReason",
    "signature" VARCHAR(88),
    "keeper_fee" DECIMAL(20,0),
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(3),

    CONSTRAINT "keeper_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "wallet" VARCHAR(44) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("wallet")
);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "nonce" TEXT NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "message" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "secret_hash" CHAR(64) NOT NULL,
    "scopes" "ApiKeyScope"[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mpp_payments" (
    "stripe_payment_intent_id" TEXT NOT NULL,
    "stripe_event_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "stripe_customer" TEXT,
    "receipt_hash" CHAR(64) NOT NULL,
    "authority_signature" VARCHAR(88) NOT NULL,
    "institution" VARCHAR(44),
    "job" VARCHAR(44),
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mpp_payments_pkey" PRIMARY KEY ("stripe_payment_intent_id")
);

-- CreateTable
CREATE TABLE "cctp_transfers" (
    "id" UUID NOT NULL,
    "source_domain" INTEGER NOT NULL,
    "nonce" DECIMAL(20,0) NOT NULL,
    "source_tx_hash" TEXT NOT NULL,
    "message_hash" CHAR(64) NOT NULL,
    "attestation" TEXT,
    "amount" DECIMAL(20,0) NOT NULL,
    "mint_recipient" VARCHAR(44) NOT NULL,
    "job" VARCHAR(44),
    "status" "CctpTransferStatus" NOT NULL,
    "receive_signature" VARCHAR(88),
    "fund_signature" VARCHAR(88),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cctp_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_rule_records" (
    "id" UUID NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "commitment" CHAR(64) NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "algorithm" TEXT NOT NULL,
    "iv" BYTEA NOT NULL,
    "kms_key_id" TEXT NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "travel_rule_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "programs_program_id_key" ON "programs"("program_id");

-- CreateIndex
CREATE INDEX "chain_events_slot_idx" ON "chain_events"("slot");

-- CreateIndex
CREATE INDEX "chain_events_program_name_slot_idx" ON "chain_events"("program", "name", "slot");

-- CreateIndex
CREATE INDEX "chain_events_job_slot_idx" ON "chain_events"("job", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "chain_events_signature_instruction_index_event_index_key" ON "chain_events"("signature", "instruction_index", "event_index");

-- CreateIndex
CREATE INDEX "institutions_owner_key_idx" ON "institutions"("owner_key");

-- CreateIndex
CREATE INDEX "institutions_multisig_vault_idx" ON "institutions"("multisig_vault");

-- CreateIndex
CREATE INDEX "policies_institution_active_idx" ON "policies"("institution", "active");

-- CreateIndex
CREATE UNIQUE INDEX "policies_institution_policy_id_key" ON "policies"("institution", "policy_id");

-- CreateIndex
CREATE INDEX "agents_owner_idx" ON "agents"("owner");

-- CreateIndex
CREATE INDEX "agents_wallet_idx" ON "agents"("wallet");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "agents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "agents_creator_agent_id_key" ON "agents"("creator", "agent_id");

-- CreateIndex
CREATE INDEX "agent_cards_skills_idx" ON "agent_cards" USING GIN ("skills");

-- CreateIndex
CREATE UNIQUE INDEX "screenings_wallet_key" ON "screenings"("wallet");

-- CreateIndex
CREATE INDEX "screenings_status_expires_at_idx" ON "screenings"("status", "expires_at");

-- CreateIndex
CREATE INDEX "jobs_status_challenge_end_idx" ON "jobs"("status", "challenge_end");

-- CreateIndex
CREATE INDEX "jobs_institution_status_idx" ON "jobs"("institution", "status");

-- CreateIndex
CREATE INDEX "jobs_agent_record_status_idx" ON "jobs"("agent_record", "status");

-- CreateIndex
CREATE INDEX "jobs_agent_wallet_idx" ON "jobs"("agent_wallet");

-- CreateIndex
CREATE INDEX "jobs_policy_idx" ON "jobs"("policy");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_institution_spec_hash_key" ON "jobs"("institution", "spec_hash");

-- CreateIndex
CREATE INDEX "disputes_job_status_raised_at_idx" ON "disputes"("job_status", "raised_at");

-- CreateIndex
CREATE INDEX "disputes_institution_idx" ON "disputes"("institution");

-- CreateIndex
CREATE INDEX "disputes_agent_record_idx" ON "disputes"("agent_record");

-- CreateIndex
CREATE UNIQUE INDEX "claims_job_key" ON "claims"("job");

-- CreateIndex
CREATE INDEX "claims_status_idx" ON "claims"("status");

-- CreateIndex
CREATE INDEX "claims_seller_idx" ON "claims"("seller");

-- CreateIndex
CREATE INDEX "claims_buyer_idx" ON "claims"("buyer");

-- CreateIndex
CREATE UNIQUE INDEX "agent_reputations_agent_record_key" ON "agent_reputations"("agent_record");

-- CreateIndex
CREATE INDEX "agent_reputations_jobs_completed_idx" ON "agent_reputations"("jobs_completed");

-- CreateIndex
CREATE UNIQUE INDEX "validation_records_job_key" ON "validation_records"("job");

-- CreateIndex
CREATE INDEX "validation_records_agent_record_idx" ON "validation_records"("agent_record");

-- CreateIndex
CREATE UNIQUE INDEX "release_proofs_job_key" ON "release_proofs"("job");

-- CreateIndex
CREATE INDEX "release_proofs_institution_idx" ON "release_proofs"("institution");

-- CreateIndex
CREATE INDEX "release_proofs_consumed_idx" ON "release_proofs"("consumed");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_job_work_hash_key" ON "deliveries"("job", "work_hash");

-- CreateIndex
CREATE INDEX "keeper_actions_job_at_idx" ON "keeper_actions"("job", "at");

-- CreateIndex
CREATE INDEX "keeper_actions_outcome_at_idx" ON "keeper_actions"("outcome", "at");

-- CreateIndex
CREATE INDEX "auth_challenges_wallet_idx" ON "auth_challenges"("wallet");

-- CreateIndex
CREATE INDEX "auth_challenges_expires_at_idx" ON "auth_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_wallet_idx" ON "sessions"("wallet");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_secret_hash_key" ON "api_keys"("secret_hash");

-- CreateIndex
CREATE INDEX "api_keys_wallet_idx" ON "api_keys"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "mpp_payments_stripe_event_id_key" ON "mpp_payments"("stripe_event_id");

-- CreateIndex
CREATE INDEX "mpp_payments_status_idx" ON "mpp_payments"("status");

-- CreateIndex
CREATE INDEX "mpp_payments_institution_idx" ON "mpp_payments"("institution");

-- CreateIndex
CREATE INDEX "mpp_payments_job_idx" ON "mpp_payments"("job");

-- CreateIndex
CREATE INDEX "cctp_transfers_status_idx" ON "cctp_transfers"("status");

-- CreateIndex
CREATE INDEX "cctp_transfers_job_idx" ON "cctp_transfers"("job");

-- CreateIndex
CREATE UNIQUE INDEX "cctp_transfers_source_domain_nonce_key" ON "cctp_transfers"("source_domain", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "cctp_transfers_message_hash_key" ON "cctp_transfers"("message_hash");

-- CreateIndex
CREATE UNIQUE INDEX "travel_rule_records_job_key" ON "travel_rule_records"("job");

-- AddForeignKey
ALTER TABLE "indexer_cursors" ADD CONSTRAINT "indexer_cursors_program_fkey" FOREIGN KEY ("program") REFERENCES "programs"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_wallet_fkey" FOREIGN KEY ("wallet") REFERENCES "users"("wallet") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_wallet_fkey" FOREIGN KEY ("wallet") REFERENCES "users"("wallet") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_wallet_fkey" FOREIGN KEY ("wallet") REFERENCES "users"("wallet") ON DELETE CASCADE ON UPDATE CASCADE;


-- Biçim kısıtları: scripts/check-constraints.mjs çıktısı (Prisma şeması CHECK ifade edemez).
ALTER TABLE "programs" ADD CONSTRAINT "programs_program_id_address" CHECK ("program_id" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "indexer_cursors" ADD CONSTRAINT "indexer_cursors_last_signature_signature" CHECK ("last_signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE "chain_events" ADD CONSTRAINT "chain_events_signature_signature" CHECK ("signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE "chain_events" ADD CONSTRAINT "chain_events_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_owner_key_address" CHECK ("owner_key" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_multisig_vault_address" CHECK ("multisig_vault" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "policies" ADD CONSTRAINT "policies_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "policies" ADD CONSTRAINT "policies_institution_address" CHECK ("institution" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "policies" ADD CONSTRAINT "policies_policy_id_hex32" CHECK ("policy_id" ~ '^[0-9a-f]{64}$');
ALTER TABLE "policy_metas" ADD CONSTRAINT "policy_metas_policy_address" CHECK ("policy" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "policy_metas" ADD CONSTRAINT "policy_metas_updated_by_address" CHECK ("updated_by" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "agents" ADD CONSTRAINT "agents_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "agents" ADD CONSTRAINT "agents_creator_address" CHECK ("creator" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_address" CHECK ("owner" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "agents" ADD CONSTRAINT "agents_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "agents" ADD CONSTRAINT "agents_agent_card_hash_hex32" CHECK ("agent_card_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_agent_record_address" CHECK ("agent_record" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_content_hash_hex32" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_source_hash_hex32" CHECK ("source_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_institution_address" CHECK ("institution" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_record_address" CHECK ("agent_record" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_wallet_address" CHECK ("agent_wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_policy_address" CHECK ("policy" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_mint_address" CHECK ("mint" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_amount_u64" CHECK ("amount" >= 0 AND "amount" <= 18446744073709551615);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_spec_hash_hex32" CHECK ("spec_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_institution_address" CHECK ("institution" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_agent_record_address" CHECK ("agent_record" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_challenger_address" CHECK ("challenger" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_bond_u64" CHECK ("bond" >= 0 AND "bond" <= 18446744073709551615);
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_reason_hash_hex32" CHECK ("reason_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "claims" ADD CONSTRAINT "claims_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "claims" ADD CONSTRAINT "claims_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "claims" ADD CONSTRAINT "claims_seller_address" CHECK ("seller" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "claims" ADD CONSTRAINT "claims_buyer_address" CHECK ("buyer" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "claims" ADD CONSTRAINT "claims_price_u64" CHECK ("price" >= 0 AND "price" <= 18446744073709551615);
ALTER TABLE "claims" ADD CONSTRAINT "claims_face_value_u64" CHECK ("face_value" >= 0 AND "face_value" <= 18446744073709551615);
ALTER TABLE "agent_reputations" ADD CONSTRAINT "agent_reputations_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "agent_reputations" ADD CONSTRAINT "agent_reputations_agent_record_address" CHECK ("agent_record" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "agent_reputations" ADD CONSTRAINT "agent_reputations_jobs_completed_u64" CHECK ("jobs_completed" >= 0 AND "jobs_completed" <= 18446744073709551615);
ALTER TABLE "agent_reputations" ADD CONSTRAINT "agent_reputations_total_earned_u64" CHECK ("total_earned" >= 0 AND "total_earned" <= 18446744073709551615);
ALTER TABLE "validation_records" ADD CONSTRAINT "validation_records_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "validation_records" ADD CONSTRAINT "validation_records_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "validation_records" ADD CONSTRAINT "validation_records_agent_record_address" CHECK ("agent_record" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "release_proofs" ADD CONSTRAINT "release_proofs_address_address" CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "release_proofs" ADD CONSTRAINT "release_proofs_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "release_proofs" ADD CONSTRAINT "release_proofs_institution_address" CHECK ("institution" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "release_proofs" ADD CONSTRAINT "release_proofs_policy_address" CHECK ("policy" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "release_proofs" ADD CONSTRAINT "release_proofs_payee_address" CHECK ("payee" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "release_proofs" ADD CONSTRAINT "release_proofs_net_amount_u64" CHECK ("net_amount" >= 0 AND "net_amount" <= 18446744073709551615);
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_work_hash_hex32" CHECK ("work_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_uploaded_by_address" CHECK ("uploaded_by" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "keeper_actions" ADD CONSTRAINT "keeper_actions_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "keeper_actions" ADD CONSTRAINT "keeper_actions_signature_signature" CHECK ("signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE "keeper_actions" ADD CONSTRAINT "keeper_actions_keeper_fee_u64" CHECK ("keeper_fee" >= 0 AND "keeper_fee" <= 18446744073709551615);
ALTER TABLE "users" ADD CONSTRAINT "users_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_hex32" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_secret_hash_hex32" CHECK ("secret_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_receipt_hash_hex32" CHECK ("receipt_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_authority_signature_signature" CHECK ("authority_signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_institution_address" CHECK ("institution" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_nonce_u64" CHECK ("nonce" >= 0 AND "nonce" <= 18446744073709551615);
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_message_hash_hex32" CHECK ("message_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_amount_u64" CHECK ("amount" >= 0 AND "amount" <= 18446744073709551615);
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_mint_recipient_address" CHECK ("mint_recipient" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_receive_signature_signature" CHECK ("receive_signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_fund_signature_signature" CHECK ("fund_signature" ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$');
ALTER TABLE "travel_rule_records" ADD CONSTRAINT "travel_rule_records_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "travel_rule_records" ADD CONSTRAINT "travel_rule_records_commitment_hex32" CHECK ("commitment" ~ '^[0-9a-f]{64}$');

-- Alana özgü kısıtlar.
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_amount_minor_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_currency_iso4217" CHECK ("currency" ~ '^[a-z]{3}$');
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_byte_size_nonnegative" CHECK ("byte_size" >= 0);
ALTER TABLE "policies" ADD CONSTRAINT "policies_version_nonnegative" CHECK ("version" >= 0);
