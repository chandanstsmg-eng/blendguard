-- Rule 17: no historical manufacturing measurement may be silently edited or deleted.
-- These triggers enforce it in the database itself, below the application.

-- Weight readings: insert only.
CREATE OR REPLACE FUNCTION bg_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BlendGuard: % on % is not permitted (append-only record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER weight_reading_append_only
  BEFORE UPDATE OR DELETE ON "WeightReading"
  FOR EACH ROW EXECUTE FUNCTION bg_forbid_change();

-- Audit events: insert only, except the sync bookkeeping columns.
CREATE OR REPLACE FUNCTION bg_audit_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BlendGuard: audit events cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW."seqNo", NEW.at, NEW."userId", NEW.role, NEW."batchId", NEW."stationId", NEW.type,
      NEW.details::text, NEW.outcome, NEW."prevState", NEW."newState", NEW."sourceDevice")
     IS DISTINCT FROM
     (OLD.id, OLD."seqNo", OLD.at, OLD."userId", OLD.role, OLD."batchId", OLD."stationId", OLD.type,
      OLD.details::text, OLD.outcome, OLD."prevState", OLD."newState", OLD."sourceDevice") THEN
    RAISE EXCEPTION 'BlendGuard: audit events cannot be edited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_guard
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION bg_audit_guard();

-- Deviations are never deleted (they may be resolved, which is an update).
CREATE TRIGGER deviation_no_delete
  BEFORE DELETE ON "Deviation"
  FOR EACH ROW EXECUTE FUNCTION bg_forbid_change();

-- An accepted ingredient weight is final once written.
CREATE OR REPLACE FUNCTION bg_step_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BlendGuard: batch steps cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."acceptedNetMg" IS NOT NULL AND (
       NEW."acceptedNetMg" IS DISTINCT FROM OLD."acceptedNetMg"
    OR NEW."acceptedGrossMg" IS DISTINCT FROM OLD."acceptedGrossMg"
    OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt"
    OR NEW."tareGrossMg" IS DISTINCT FROM OLD."tareGrossMg"
    OR NEW."lotId" IS DISTINCT FROM OLD."lotId"
    OR NEW."targetMg" IS DISTINCT FROM OLD."targetMg") THEN
    RAISE EXCEPTION 'BlendGuard: an accepted ingredient measurement cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER batch_step_guard
  BEFORE UPDATE OR DELETE ON "BatchStep"
  FOR EACH ROW EXECUTE FUNCTION bg_step_guard();
