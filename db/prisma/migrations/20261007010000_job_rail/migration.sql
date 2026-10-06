-- CreateEnum
CREATE TYPE "SettlementRail" AS ENUM ('escrow', 'fiat');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "rail" "SettlementRail" NOT NULL DEFAULT 'escrow';
