-- Publication rules (security review): who may move a product to which status.
--
-- A user's listing must pass screening before buyers can see or buy it, so the
-- web role (app_web, the company owner through the RLS policies of 0012) may make only
-- these moves on its own products:
--     DRAFT -> SCREENING   (submit a draft, optionally naming the version to screen)
--     PUBLISHED -> ARCHIVED (withdraw a listing)
-- and it creates products only as DRAFT. Every other status - PUBLISHED, NEEDS_REVIEW,
-- REJECTED, HIDDEN - is set only by the job runner (app_jobs: the screening job and
-- moderation) or the owner. current_version_id changes only together with a status move the
-- role may make (app_web: one of the two above), and always names a version of the product
-- itself. app_pay changes neither (it writes available_units only).
--
-- A BEFORE trigger, not SECURITY DEFINER, so current_user is the role that wrote the row;
-- the version lookup therefore runs under that role's RLS (app_web sees its own company's
-- versions).
CREATE FUNCTION core.guard_product_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  privileged boolean := current_user = 'app_jobs'
                        OR COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
                        OR pg_has_role(current_user, 'migrator', 'MEMBER');
  status_moved boolean := TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status;
  version_moved boolean := CASE WHEN TG_OP = 'INSERT' THEN NEW.current_version_id IS NOT NULL
                                ELSE NEW.current_version_id IS DISTINCT FROM OLD.current_version_id END;
BEGIN
  IF version_moved AND NEW.current_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM core.product_version v WHERE v.id = NEW.current_version_id AND v.product_id = NEW.id) THEN
    RAISE EXCEPTION 'product %: the current version must be a version of this product', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF privileged THEN
    RETURN NEW;
  END IF;

  IF current_user = 'app_web' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'a new product starts as DRAFT' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
    IF status_moved AND (OLD.status, NEW.status) NOT IN (('DRAFT', 'SCREENING'), ('PUBLISHED', 'ARCHIVED')) THEN
      RAISE EXCEPTION 'product %: % -> % is set by screening or moderation, not by the seller', NEW.id, OLD.status, NEW.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF version_moved AND NOT status_moved THEN
      RAISE EXCEPTION 'product %: the current version changes only together with a status move the seller may make', NEW.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- every other application role (app_pay issues stock): status and version are not its to set
  IF status_moved OR version_moved THEN
    RAISE EXCEPTION 'product %: % may not set a product''s status or current version', NEW.id, current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_status BEFORE INSERT OR UPDATE ON core.product
  FOR EACH ROW EXECUTE FUNCTION core.guard_product_status();

REVOKE ALL ON FUNCTION core.guard_product_status() FROM PUBLIC;
