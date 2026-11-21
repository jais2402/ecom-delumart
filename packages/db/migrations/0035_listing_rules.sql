-- Player listings, part 1: the records and the structural rules (US-08, US-29).
--
-- Products, versions, warehouses and inventory units are now written ONLY by the owner-run
-- SECURITY DEFINER commands of 0036/0037 (the studio, screening, publication, stock and
-- moderation). The direct writes the application roles held since 0011 are revoked: app_web no
-- longer inserts draft products or versions or moves a product's status, and app_jobs no longer
-- writes products, versions, warehouses or units (it applies a screening result through
-- core.screening_apply only).
--
-- New records:
--   core.listing_submission  one row per submission of a revision for screening (the first
--                            publication or a revision of a live listing): the pinned version,
--                            its state (SCREENING, NEEDS_REVIEW, APPROVED, REJECTED, WITHDRAWN,
--                            SUPERSEDED), the screening reasons and the moderator's reason;
--   core.exclusive_edition   one row per EXCLUSIVE product, created at its first publication: its
--                            supply, which never changes;
--   core.price_history       append-only: every price a listing went live at.
--
-- Structural rules, enforced by trigger for EVERY writer (the owner included unless noted):
--   * a product's status and current version move only as the owner (0017, narrowed here);
--   * once a product has been published, its inventory mode, exclusive supply, company, seller
--     type and publication time never change;
--   * an exclusive edition's supply equals its product's exclusive supply, and never changes; a
--     product has at most one edition (primary key);
--   * an inventory unit is stocked only in a warehouse of its product's own company; a unit of an
--     EXCLUSIVE product carries a serial from 1 to the product's supply;
--   * a USER product's first move to PUBLISHED needs, at commit, a publication time, at least one
--     AVAILABLE unit and, for EXCLUSIVE, its edition record with exactly `supply` units numbered
--     1..supply (deferred: checked on the transaction's final state);
--   * product versions are immutable (no UPDATE); a version is deleted only with a draft that was
--     never published;
--   * submissions, editions and price history are never deleted; price history is never changed.
-- Capacity (warehouse.used <= capacity, used = its AVAILABLE units) is enforced since 0005/0016.

-- ---------------------------------------------------------------- columns
ALTER TABLE core.product
  -- STANDARD_STOCKED: the units to allocate at the first publication
  ADD COLUMN planned_quantity     int CHECK (planned_quantity IS NULL OR planned_quantity >= 1),
  -- the revision pinned for screening or review (first publication or a revision of a live listing)
  ADD COLUMN pending_version_id   uuid,
  -- approved for its first publication, but not published: the starter warehouse lacked the room
  -- (or the published cap was reached); the owner frees space or lowers the quantity and calls
  -- core.product_allocate_and_publish
  ADD COLUMN approved_needs_stock boolean NOT NULL DEFAULT false,
  -- the last moderation reason shown to the owner (a rejection or a hide); never personal data
  ADD COLUMN moderation_reason    text CHECK (moderation_reason IS NULL OR char_length(moderation_reason) <= 500),
  ADD COLUMN created_at           timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at           timestamptz,
  ADD CONSTRAINT product_needs_stock_unpublished CHECK (NOT approved_needs_stock OR published_at IS NULL);

ALTER TABLE core.product_version
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------- records
CREATE TABLE core.listing_submission (
  id             uuid PRIMARY KEY,
  product_id     uuid NOT NULL REFERENCES core.product (id),
  version_id     uuid NOT NULL REFERENCES core.product_version (id),
  company_id     uuid NOT NULL REFERENCES core.company (id),
  kind           text NOT NULL CHECK (kind IN ('FIRST', 'REVISION')),
  state          text NOT NULL CHECK (state IN ('SCREENING', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED')),
  -- screening reasons [{field, code}] (codes only, never text)
  reasons        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reasons) = 'array'),
  decided_by     text CHECK (decided_by IN ('SCREENING', 'SUPER_ADMIN', 'OWNER')),
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 500),
  submitted_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at     timestamptz
);
-- at most one open submission per product
CREATE UNIQUE INDEX listing_submission_one_open ON core.listing_submission (product_id)
  WHERE state IN ('SCREENING', 'NEEDS_REVIEW');
CREATE INDEX listing_submission_open ON core.listing_submission (state, submitted_at)
  WHERE state IN ('SCREENING', 'NEEDS_REVIEW');
CREATE INDEX listing_submission_company_day ON core.listing_submission (company_id, submitted_at);

CREATE TABLE core.exclusive_edition (
  product_id   uuid PRIMARY KEY REFERENCES core.product (id),   -- one edition per product
  supply       int NOT NULL CHECK (supply >= 1),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE core.price_history (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id     uuid NOT NULL REFERENCES core.product (id),
  version_id     uuid NOT NULL REFERENCES core.product_version (id),
  price_paise    bigint NOT NULL CHECK (price_paise > 0),
  previous_paise bigint CHECK (previous_paise IS NULL OR previous_paise > 0),
  reason         text NOT NULL CHECK (reason IN ('PUBLISHED', 'PRICE_CHANGE', 'REVISION')),
  changed_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX price_history_product ON core.price_history (product_id, id);

ALTER TABLE core.listing_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.exclusive_edition ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.price_history ENABLE ROW LEVEL SECURITY;
-- read and written only through the definer functions of 0036-0038: no role but the owner (which
-- bypasses RLS) sees or writes a row, whatever it is granted
REVOKE ALL ON core.listing_submission, core.exclusive_edition, core.price_history
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.listing_submission USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.exclusive_edition USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.price_history USING (false) WITH CHECK (false);

-- ---------------------------------------------------------------- no direct writes by application roles
REVOKE INSERT, UPDATE ON core.product FROM app_web, app_jobs;
REVOKE INSERT, UPDATE ON core.product_version FROM app_web, app_jobs;
REVOKE INSERT, UPDATE ON core.warehouse FROM app_jobs;
REVOKE INSERT, UPDATE ON core.inventory_unit FROM app_jobs;
DROP POLICY web_company_insert ON core.product;
DROP POLICY web_update ON core.product;
DROP POLICY web_company_insert ON core.product_version;

-- 0017, narrowed: no application role moves a product's status or current version any more;
-- only the owner (the definer functions; superuser or a member of migrator) does. The current
-- version is always a version of the product itself, whoever writes it.
CREATE OR REPLACE FUNCTION core.guard_product_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  privileged boolean := COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
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
  IF NOT privileged AND (status_moved OR version_moved) THEN
    RAISE EXCEPTION 'product %: % may not set a product''s status or current version (the listing commands do)',
      NEW.id, current_user USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- what never changes once published
CREATE FUNCTION core.guard_published_product() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND (NEW.inventory_mode, NEW.exclusive_supply, NEW.company_id, NEW.seller_type, NEW.published_at)
         IS DISTINCT FROM (OLD.inventory_mode, OLD.exclusive_supply, OLD.company_id, OLD.seller_type, OLD.published_at) THEN
    RAISE EXCEPTION 'product %: its inventory mode, exclusive supply, seller and publication time never change once published', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.exclusive_supply IS DISTINCT FROM OLD.exclusive_supply
     AND EXISTS (SELECT 1 FROM core.exclusive_edition e WHERE e.product_id = OLD.id) THEN
    RAISE EXCEPTION 'product %: an exclusive edition''s supply never changes', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_published BEFORE UPDATE ON core.product
  FOR EACH ROW EXECUTE FUNCTION core.guard_published_product();

-- ---------------------------------------------------------------- the exclusive edition
CREATE FUNCTION core.guard_exclusive_edition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'exclusive edition of %: its supply never changes', OLD.product_id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.product p
                  WHERE p.id = NEW.product_id AND p.seller_type = 'USER' AND p.inventory_mode = 'EXCLUSIVE'
                    AND p.exclusive_supply = NEW.supply) THEN
    RAISE EXCEPTION 'exclusive edition of %: only for an EXCLUSIVE user product, with its exclusive supply', NEW.product_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON core.exclusive_edition
  FOR EACH ROW EXECUTE FUNCTION core.guard_exclusive_edition();

-- ---------------------------------------------------------------- units
CREATE FUNCTION core.guard_unit_stocking() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p core.product;
BEGIN
  SELECT * INTO p FROM core.product pr WHERE pr.id = NEW.product_id;
  IF TG_OP = 'INSERT' OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
    IF p.company_id IS NULL OR NOT EXISTS (SELECT 1 FROM core.warehouse w
                                             WHERE w.id = NEW.warehouse_id AND w.company_id = p.company_id) THEN
      RAISE EXCEPTION 'inventory unit %: stocked only in a warehouse of its product''s own company', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND p.inventory_mode = 'EXCLUSIVE'
     AND (NEW.serial IS NULL OR NEW.serial < 1 OR NEW.serial > p.exclusive_supply
          OR NEW.serial > COALESCE((SELECT e.supply FROM core.exclusive_edition e WHERE e.product_id = p.id), NEW.serial)) THEN
    RAISE EXCEPTION 'inventory unit %: an exclusive edition''s units are numbered 1 to its supply', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_stocking BEFORE INSERT OR UPDATE ON core.inventory_unit
  FOR EACH ROW EXECUTE FUNCTION core.guard_unit_stocking();

-- ---------------------------------------------------------------- the first publication
CREATE FUNCTION core.assert_first_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p        core.product;
  units    int;
  avail    int;
  serials  int;
  edition  int;
BEGIN
  PERFORM ledger.require_read_committed();
  SELECT * INTO p FROM core.product pr WHERE pr.id = NEW.id;
  IF p.status <> 'PUBLISHED' OR p.seller_type <> 'USER' THEN
    RETURN NULL;   -- moved on again in the same transaction; judged when it is published
  END IF;
  SELECT count(*), count(*) FILTER (WHERE u.state = 'AVAILABLE'),
         count(DISTINCT u.serial) FILTER (WHERE u.serial BETWEEN 1 AND COALESCE(p.exclusive_supply, 0))
    INTO units, avail, serials
    FROM core.inventory_unit u WHERE u.product_id = p.id;
  IF p.published_at IS NULL OR p.current_version_id IS NULL OR avail < 1 THEN
    RAISE EXCEPTION 'product %: a first publication needs a publication time, a current version and allocated stock', p.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF p.inventory_mode = 'EXCLUSIVE' THEN
    SELECT e.supply INTO edition FROM core.exclusive_edition e WHERE e.product_id = p.id;
    IF edition IS NULL OR edition <> p.exclusive_supply OR units <> edition OR serials <> edition THEN
      RAISE EXCEPTION 'product %: an exclusive edition is published with its edition record and exactly its supply of numbered units', p.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER first_publication AFTER UPDATE ON core.product
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.published_at IS NULL AND NEW.status = 'PUBLISHED' AND OLD.status IS DISTINCT FROM 'PUBLISHED')
  EXECUTE FUNCTION core.assert_first_publication();

-- ---------------------------------------------------------------- versions are immutable
CREATE FUNCTION core.guard_product_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'product version % is immutable; a change is a new revision', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM core.product p WHERE p.id = OLD.product_id AND p.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'product version %: versions of a published product are never deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER guard BEFORE UPDATE OR DELETE ON core.product_version
  FOR EACH ROW EXECUTE FUNCTION core.guard_product_version();

-- A product row is deleted only as a draft that was never published.
CREATE FUNCTION core.guard_product_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.published_at IS NOT NULL OR OLD.status NOT IN ('DRAFT', 'REJECTED', 'NEEDS_REVIEW') THEN
    RAISE EXCEPTION 'product %: only a draft that was never published is deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER guard_delete BEFORE DELETE ON core.product
  FOR EACH ROW EXECUTE FUNCTION core.guard_product_delete();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.product
  FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete();

-- ---------------------------------------------------------------- price history is append-only
CREATE FUNCTION core.refuse_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '%.% rows never change', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER no_update BEFORE UPDATE ON core.price_history
  FOR EACH ROW EXECUTE FUNCTION core.refuse_change();
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.price_history', 'core.exclusive_edition'] LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.refuse_delete()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete()', t);
  END LOOP;
END $$;
-- a submission is deleted only with its never-published draft
CREATE FUNCTION core.guard_submission_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.product p WHERE p.id = OLD.product_id AND p.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'listing submission %: the moderation history of a published product is kept', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER guard_delete BEFORE DELETE ON core.listing_submission
  FOR EACH ROW EXECUTE FUNCTION core.guard_submission_delete();

REVOKE ALL ON FUNCTION core.guard_published_product(), core.guard_exclusive_edition(), core.guard_unit_stocking(),
  core.assert_first_publication(), core.guard_product_version(), core.guard_product_delete(), core.refuse_change(),
  core.guard_submission_delete()
FROM PUBLIC;
