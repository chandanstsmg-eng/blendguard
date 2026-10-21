-- Supervisor approval / rejection of a submitted batch.
-- Every column name starts with "approv" or "reject": on a SUBMITTED batch these
-- (with status SUBMITTED -> APPROVED / REJECTED and version) are the only columns
-- the batch immutability trigger allows to change.
ALTER TABLE "Batch" ADD COLUMN "approvedById" TEXT,
ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "approvalNote" TEXT,
ADD COLUMN "rejectedById" TEXT,
ADD COLUMN "rejectedAt" TIMESTAMP(3),
ADD COLUMN "rejectReason" TEXT;

-- A decision is either an approval or a rejection, never both, and always says who and when.
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_single_decision" CHECK ("approvedAt" IS NULL OR "rejectedAt" IS NULL);
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_approval_complete" CHECK (("approvedAt" IS NULL) = ("approvedById" IS NULL));
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_rejection_complete" CHECK (("rejectedAt" IS NULL) = ("rejectedById" IS NULL) AND ("rejectedAt" IS NULL OR "rejectReason" IS NOT NULL));
