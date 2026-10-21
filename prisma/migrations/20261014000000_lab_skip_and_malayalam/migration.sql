-- Ingredients a supervisor skips until the lab report clears them, and the
-- batch state for "everything else is done, waiting for the lab ingredient".
-- Operator languages are now English, Hindi and Malayalam (Kannada removed).

-- AlterEnum
ALTER TYPE "BatchStatus" ADD VALUE 'AWAITING_LAB' BEFORE 'SUBMITTED';

-- AlterEnum
ALTER TYPE "StepStatus" ADD VALUE 'SKIPPED';

-- AlterTable
ALTER TABLE "BatchStep" ADD COLUMN     "skippedAt" TIMESTAMP(3),
ADD COLUMN     "skippedById" TEXT,
ADD COLUMN     "skipNote" TEXT,
ADD COLUMN     "labReleasedAt" TIMESTAMP(3),
ADD COLUMN     "labReleasedById" TEXT;

-- Kannada is no longer offered: anyone set to it falls back to English.
UPDATE "User" SET "language" = 'en' WHERE "language" = 'kn';
UPDATE "Station" SET "defaultLanguage" = 'en' WHERE "defaultLanguage" = 'kn';
