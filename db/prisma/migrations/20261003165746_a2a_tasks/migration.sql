-- CreateEnum
CREATE TYPE "A2aTaskState" AS ENUM ('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED');

-- CreateEnum
CREATE TYPE "A2aRole" AS ENUM ('ROLE_USER', 'ROLE_AGENT');

-- CreateTable
CREATE TABLE "a2a_tasks" (
    "id" UUID NOT NULL,
    "agent_record" VARCHAR(44) NOT NULL,
    "caller" TEXT NOT NULL,
    "context_id" TEXT NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "spec_hash" CHAR(64) NOT NULL,
    "state" "A2aTaskState" NOT NULL,
    "status_message" JSONB NOT NULL DEFAULT '{}',
    "status_at" TIMESTAMPTZ(3) NOT NULL,
    "artifacts" JSONB NOT NULL DEFAULT '[]',
    "create_message_id" TEXT NOT NULL,
    "create_hash" CHAR(64) NOT NULL,
    "job_status" "JobStatus",
    "job_slot" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "a2a_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "a2a_messages" (
    "id" BIGSERIAL NOT NULL,
    "task_id" UUID NOT NULL,
    "message_id" TEXT NOT NULL,
    "role" "A2aRole" NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "a2a_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "a2a_tasks_agent_record_caller_status_at_idx" ON "a2a_tasks"("agent_record", "caller", "status_at" DESC);

-- CreateIndex
CREATE INDEX "a2a_tasks_agent_record_context_id_idx" ON "a2a_tasks"("agent_record", "context_id");

-- CreateIndex
CREATE INDEX "a2a_tasks_agent_record_job_idx" ON "a2a_tasks"("agent_record", "job");

-- CreateIndex
CREATE UNIQUE INDEX "a2a_tasks_agent_record_caller_create_message_id_key" ON "a2a_tasks"("agent_record", "caller", "create_message_id");

-- CreateIndex
CREATE INDEX "a2a_messages_task_id_id_idx" ON "a2a_messages"("task_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "a2a_messages_task_id_message_id_key" ON "a2a_messages"("task_id", "message_id");

-- AddForeignKey
ALTER TABLE "a2a_messages" ADD CONSTRAINT "a2a_messages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "a2a_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Biçim kısıtları: scripts/check-constraints.mjs çıktısı (Prisma şeması CHECK ifade edemez).
ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_agent_record_address" CHECK ("agent_record" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_spec_hash_hex32" CHECK ("spec_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_create_hash_hex32" CHECK ("create_hash" ~ '^[0-9a-f]{64}$');
