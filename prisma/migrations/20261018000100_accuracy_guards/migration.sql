-- Accuracy and record-integrity guards (go-live review).
--
-- New trigger functions use their own names (bg_step_lock, bg_batch_lock,
-- bg_formula_line_lock, bg_deviation_lock, bg_no_truncate) and sit next to the
-- existing bg_forbid_change / bg_audit_guard / bg_step_guard, which are left as they are.

-- What a supervisor's resolution was based on (written once, at resolution).
ALTER TABLE "Deviation" ADD COLUMN "resolutionDetails" JSONB;

-- Spent supervisor sign-off tokens: each token works once, for one action, even after a restart.
CREATE TABLE "SignoffUse" (
    "jti" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "usedById" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignoffUse_pkey" PRIMARY KEY ("jti")
);

CREATE TRIGGER signoff_use_append_only
  BEFORE UPDATE OR DELETE ON "SignoffUse"
  FOR EACH ROW EXECUTE FUNCTION bg_forbid_change();

-- (a) Batch steps: a completed step is frozen; the line it is weighed against
-- (target, tolerances, ingredient) is frozen from the moment the scale was zeroed for it.
CREATE OR REPLACE FUNCTION bg_step_lock() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'BlendGuard: a completed ingredient step cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."tareGrossMg" IS NOT NULL AND
     (NEW."targetMg", NEW."tolMinusMg", NEW."tolPlusMg", NEW."ingredientId", NEW."ingredientCode")
     IS DISTINCT FROM
     (OLD."targetMg", OLD."tolMinusMg", OLD."tolPlusMg", OLD."ingredientId", OLD."ingredientCode") THEN
    RAISE EXCEPTION 'BlendGuard: the quantity, tolerance and ingredient cannot be changed once the scale was zeroed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER batch_step_lock
  BEFORE UPDATE ON "BatchStep"
  FOR EACH ROW EXECUTE FUNCTION bg_step_lock();

-- (b) Batches: once submitted, only the review decision may be recorded:
-- status SUBMITTED → (UNDER_REVIEW →) APPROVED / REJECTED, columns named approv* / reject*
-- while the decision is open, and the optimistic-lock version. After the decision only
-- the version may change. A simulated (training) batch can never become a production one.
CREATE OR REPLACE FUNCTION bg_batch_lock() RETURNS trigger AS $$
DECLARE
  o jsonb;
  n jsonb;
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED') THEN
      RAISE EXCEPTION 'BlendGuard: a submitted batch cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.simulated AND NOT NEW.simulated THEN
    RAISE EXCEPTION 'BlendGuard: a batch weighed on a simulated scale stays a training record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status NOT IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED') THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'SUBMITTED' AND NEW.status IN ('UNDER_REVIEW', 'APPROVED', 'REJECTED'))
    OR (OLD.status = 'UNDER_REVIEW' AND NEW.status IN ('APPROVED', 'REJECTED'))) THEN
    RAISE EXCEPTION 'BlendGuard: a submitted batch can only be approved or rejected (not % → %)', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  FOR k IN SELECT jsonb_object_keys(o) LOOP
    IF k IN ('status', 'version')
       OR (OLD.status IN ('SUBMITTED', 'UNDER_REVIEW') AND (k LIKE 'approv%' OR k LIKE 'reject%')) THEN
      o := o - k;
      n := n - k;
    END IF;
  END LOOP;
  IF o IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'BlendGuard: a submitted batch record cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER batch_lock
  BEFORE UPDATE OR DELETE ON "Batch"
  FOR EACH ROW EXECUTE FUNCTION bg_batch_lock();

-- (c) The lines of an approved formula revision (also once superseded) are what was approved.
CREATE OR REPLACE FUNCTION bg_formula_line_lock() RETURNS trigger AS $$
DECLARE
  s text;
BEGIN
  SELECT status::text INTO s FROM "Formula" WHERE id = OLD."formulaId";
  IF s IN ('APPROVED', 'SUPERSEDED') AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'BlendGuard: the lines of an approved formula cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER formula_line_lock
  BEFORE UPDATE OR DELETE ON "FormulaLine"
  FOR EACH ROW EXECUTE FUNCTION bg_formula_line_lock();

-- (d) Deviations: what was raised never changes; once resolved, nothing changes.
CREATE OR REPLACE FUNCTION bg_deviation_lock() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW."batchId", NEW."stepId", NEW.type, NEW.details, NEW."raisedById", NEW."raisedAt")
     IS DISTINCT FROM
     (OLD.id, OLD."batchId", OLD."stepId", OLD.type, OLD.details, OLD."raisedById", OLD."raisedAt") THEN
    RAISE EXCEPTION 'BlendGuard: a raised deviation cannot be edited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."resolvedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'BlendGuard: a resolved deviation cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deviation_lock
  BEFORE UPDATE ON "Deviation"
  FOR EACH ROW EXECUTE FUNCTION bg_deviation_lock();

-- (e) Row triggers do not fire on TRUNCATE; refuse it on the GMP record tables.
CREATE OR REPLACE FUNCTION bg_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BlendGuard: TRUNCATE on % is not permitted (manufacturing record)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON "AuditEvent" FOR EACH STATEMENT EXECUTE FUNCTION bg_no_truncate();
CREATE TRIGGER weight_reading_no_truncate BEFORE TRUNCATE ON "WeightReading" FOR EACH STATEMENT EXECUTE FUNCTION bg_no_truncate();
CREATE TRIGGER batch_step_no_truncate BEFORE TRUNCATE ON "BatchStep" FOR EACH STATEMENT EXECUTE FUNCTION bg_no_truncate();
CREATE TRIGGER batch_no_truncate BEFORE TRUNCATE ON "Batch" FOR EACH STATEMENT EXECUTE FUNCTION bg_no_truncate();
CREATE TRIGGER deviation_no_truncate BEFORE TRUNCATE ON "Deviation" FOR EACH STATEMENT EXECUTE FUNCTION bg_no_truncate();
