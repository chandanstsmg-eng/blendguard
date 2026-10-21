-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OPERATOR', 'SUPERVISOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'ON_HOLD', 'AWAITING_SUBMISSION', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CORRECTION');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('LOCKED', 'CURRENT', 'COMPLETED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "StepStage" AS ENUM ('FIND', 'SCAN', 'WEIGH', 'DONE');

-- CreateEnum
CREATE TYPE "FormulaStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('RELEASED', 'QUARANTINE', 'REJECTED');

-- CreateEnum
CREATE TYPE "ScaleMode" AS ENUM ('SIMULATED', 'SERIAL', 'BRIDGE');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ReadingPurpose" AS ENUM ('TARE', 'ACCEPT_ATTEMPT', 'AUTO_OVERWEIGHT', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "ReadingVerdict" AS ENUM ('UNDER', 'OK', 'OVER', 'UNSTABLE', 'DISCONNECTED', 'NOT_TARED', 'NOT_VALIDATED', 'CANNOT_CERTIFY');

-- CreateEnum
CREATE TYPE "DeviationType" AS ENUM ('OVERWEIGHT', 'VESSEL_CHANGED', 'OTHER');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "operatorCode" TEXT,
    "username" TEXT,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "pinHash" TEXT,
    "passwordHash" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "aaguid" TEXT,
    "label" TEXT NOT NULL,
    "deviceType" TEXT,
    "stationId" TEXT,
    "enrolledById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stationId" TEXT,
    "method" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "id" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "stationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT,
    "boundAt" TIMESTAMP(3),
    "allowFingerprint" BOOLEAN NOT NULL DEFAULT true,
    "allowFace" BOOLEAN NOT NULL DEFAULT false,
    "allowPin" BOOLEAN NOT NULL DEFAULT false,
    "allowAssisted" BOOLEAN NOT NULL DEFAULT true,
    "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
    "audioEnabled" BOOLEAN NOT NULL DEFAULT true,
    "audioVolume" INTEGER NOT NULL DEFAULT 80,
    "allowPause" BOOLEAN NOT NULL DEFAULT true,
    "scaleMode" "ScaleMode" NOT NULL DEFAULT 'SIMULATED',
    "scaleModel" TEXT NOT NULL DEFAULT 'Simulator',
    "scaleResolutionMg" INTEGER NOT NULL DEFAULT 10,
    "scaleUncertaintyMg" INTEGER NOT NULL DEFAULT 20,
    "scaleValidatedUntil" TIMESTAMP(3),
    "scaleValidatedAt" TIMESTAMP(3),
    "scaleValidatedById" TEXT,
    "vesselDriftLimitMg" INTEGER NOT NULL DEFAULT 500,
    "simGrossMg" INTEGER NOT NULL DEFAULT -1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationAccess" (
    "userId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,

    CONSTRAINT "StationAccess_pkey" PRIMARY KEY ("userId","stationId")
);

-- CreateTable
CREATE TABLE "Rack" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "cols" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Rack_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "barcode" TEXT,
    "lotTracked" BOOLEAN NOT NULL DEFAULT false,
    "rackCode" TEXT,
    "bin" INTEGER,
    "handling" TEXT[],
    "hazards" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientLot" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "status" "LotStatus" NOT NULL DEFAULT 'RELEASED',
    "expiresOn" TIMESTAMP(3),

    CONSTRAINT "IngredientLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Formula" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "perfumeName" TEXT NOT NULL,
    "status" "FormulaStatus" NOT NULL DEFAULT 'DRAFT',
    "sopNumber" TEXT,
    "batchSizeMg" INTEGER NOT NULL,
    "notes" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Formula_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormulaLine" (
    "id" TEXT NOT NULL,
    "formulaId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "targetMg" INTEGER NOT NULL,
    "tolMinusMg" INTEGER NOT NULL,
    "tolPlusMg" INTEGER NOT NULL,
    "remarks" TEXT,

    CONSTRAINT "FormulaLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "formulaId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "backupOperatorId" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "plannedStart" TIMESTAMP(3),
    "instructions" TEXT,
    "status" "BatchStatus" NOT NULL DEFAULT 'ASSIGNED',
    "holdReason" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "submittedById" TEXT,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchStep" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "ingredientCode" TEXT NOT NULL,
    "ingredientName" TEXT NOT NULL,
    "targetMg" INTEGER NOT NULL,
    "tolMinusMg" INTEGER NOT NULL,
    "tolPlusMg" INTEGER NOT NULL,
    "remarks" TEXT,
    "status" "StepStatus" NOT NULL DEFAULT 'LOCKED',
    "stage" "StepStage" NOT NULL DEFAULT 'FIND',
    "holdReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "foundAt" TIMESTAMP(3),
    "scannedAt" TIMESTAMP(3),
    "scannedBarcode" TEXT,
    "lotId" TEXT,
    "lotNumber" TEXT,
    "wrongScans" INTEGER NOT NULL DEFAULT 0,
    "tareGrossMg" INTEGER,
    "taredAt" TIMESTAMP(3),
    "acceptedNetMg" INTEGER,
    "acceptedGrossMg" INTEGER,
    "acceptedAt" TIMESTAMP(3),
    "completedById" TEXT,

    CONSTRAINT "BatchStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeightReading" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "purpose" "ReadingPurpose" NOT NULL,
    "grossMg" INTEGER,
    "tareMg" INTEGER,
    "netMg" INTEGER,
    "stable" BOOLEAN NOT NULL,
    "verdict" "ReadingVerdict" NOT NULL,
    "source" TEXT NOT NULL,
    "scaleModel" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeightReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deviation" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "stepId" TEXT,
    "type" "DeviationType" NOT NULL,
    "details" JSONB NOT NULL,
    "raisedById" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "Deviation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorCall" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "batchId" TEXT,
    "seq" INTEGER,
    "raisedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,

    CONSTRAINT "SupervisorCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "seqNo" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "role" TEXT,
    "batchId" TEXT,
    "stationId" TEXT,
    "type" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "prevState" TEXT,
    "newState" TEXT,
    "sourceDevice" TEXT,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncedAt" TIMESTAMP(3),
    "syncError" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_operatorCode_key" ON "User"("operatorCode");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "WebAuthnCredential_userId_idx" ON "WebAuthnCredential"("userId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthChallenge_challenge_key" ON "AuthChallenge"("challenge");

-- CreateIndex
CREATE UNIQUE INDEX "Station_code_key" ON "Station"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Station_tokenHash_key" ON "Station"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_code_key" ON "Ingredient"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_barcode_key" ON "Ingredient"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "IngredientLot_barcode_key" ON "IngredientLot"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "IngredientLot_ingredientId_lotNumber_key" ON "IngredientLot"("ingredientId", "lotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Formula_code_revision_key" ON "Formula"("code", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "FormulaLine_formulaId_seq_key" ON "FormulaLine"("formulaId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_batchNo_key" ON "Batch"("batchNo");

-- CreateIndex
CREATE INDEX "Batch_operatorId_status_idx" ON "Batch"("operatorId", "status");

-- CreateIndex
CREATE INDEX "Batch_stationId_status_idx" ON "Batch"("stationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BatchStep_batchId_seq_key" ON "BatchStep"("batchId", "seq");

-- CreateIndex
CREATE INDEX "WeightReading_stepId_idx" ON "WeightReading"("stepId");

-- CreateIndex
CREATE INDEX "Deviation_batchId_idx" ON "Deviation"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_seqNo_key" ON "AuditEvent"("seqNo");

-- CreateIndex
CREATE INDEX "AuditEvent_batchId_idx" ON "AuditEvent"("batchId");

-- CreateIndex
CREATE INDEX "AuditEvent_type_at_idx" ON "AuditEvent"("type", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_syncStatus_idx" ON "AuditEvent"("syncStatus");

-- AddForeignKey
ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAccess" ADD CONSTRAINT "StationAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAccess" ADD CONSTRAINT "StationAccess_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientLot" ADD CONSTRAINT "IngredientLot_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormulaLine" ADD CONSTRAINT "FormulaLine_formulaId_fkey" FOREIGN KEY ("formulaId") REFERENCES "Formula"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormulaLine" ADD CONSTRAINT "FormulaLine_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_formulaId_fkey" FOREIGN KEY ("formulaId") REFERENCES "Formula"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_backupOperatorId_fkey" FOREIGN KEY ("backupOperatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchStep" ADD CONSTRAINT "BatchStep_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightReading" ADD CONSTRAINT "WeightReading_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightReading" ADD CONSTRAINT "WeightReading_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "BatchStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deviation" ADD CONSTRAINT "Deviation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deviation" ADD CONSTRAINT "Deviation_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "BatchStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorCall" ADD CONSTRAINT "SupervisorCall_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorCall" ADD CONSTRAINT "SupervisorCall_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
