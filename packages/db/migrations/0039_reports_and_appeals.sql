-- Trust and safety, part 1: reports, the automatic hide at three independent reports, the Super
-- Admin's report cases, and appeals of moderation decisions (PRD §7.7, R-solo moderation; LLD §6
-- product listing "PUBLISHED --> HIDDEN: moderation or 3 reports", "HIDDEN --> PUBLISHED: appeal
-- upheld"; §11.2 reports 5 / hour / account).
--
-- Records (owner-only tables: no application role reads or writes a row; everything goes through
-- the SECURITY DEFINER commands below, owner-owned, search_path pg_catalog, pg_temp):
--   core.listing_hide  one row per time a listing went HIDDEN (any writer: a trigger on
--                      core.product records it), lifted when it leaves HIDDEN. A hide is the
--                      "moderation action" an appeal of a hidden listing refers to.
--   core.report_case   the open case of one target (a PUBLISHED player product, or a store): at
--                      most one OPEN case per target; it records the hide it caused, if any.
--   core.report        one report: case, reporter, reason code, optional detail (never shown to
--                      the reported party), the web layer's screening flags for the detail, and an
--                      unguessable case reference `R-` + 10 symbols. One report per reporter per
--                      case, so one open report per reporter per target.
--   core.appeal        one appeal per moderation action: a rejected first submission
--                      (core.listing_submission) or a hide (core.listing_hide); unique on each.
--
-- Commands (app_web; the database derives the actor from the sign-in session):
--   core.report_create(target_type, target_id, reason, detail, detail_flags) -> {reference}
--     Any onboarded user (ONBOARDING_REQUIRED). At most `reports_per_hour` (5) committed reports
--     per account per rolling hour, counted under the actor's report lock (REPORT_LIMIT); the web
--     layer also counts calls with core.rate_hit. ALREADY_REPORTED while the reporter's report on
--     the target is open. A product must be a PUBLISHED player product (NOT_FOUND otherwise, as a
--     store that does not exist); nobody reports their own store or listing.
--     Safety net: under the product's row lock (LLD §4 #6), when the product's open case has
--     reports from `report_hide_threshold` (3) distinct reporters whose accounts are at least
--     `report_reporter_min_age_hours` (24) old, who are active and are not a party of the
--     product's company (its owner), the product goes HIDDEN in the same transaction with the
--     owner-visible reason "Hidden pending review", a SYSTEM row in the audit chain and a
--     `listing_hidden` outbox event (ids only).
--   core.my_reports() -> the actor's own reports with their case status only.
--   core.appeal_create(product_id, statement) -> {appealId}: the owner of a REJECTED (first
--     submission rejected by screening or the Super Admin) or HIDDEN listing, once per action
--     (APPEAL_EXISTS); NOT_APPEALABLE for any other state; another company's listing is NOT_FOUND.
--     Statement 20-1,000 characters, no control characters but line breaks.
--   core.my_appeals() -> the owner's appeals; core.my_product(id) now carries `appeal` (the latest
--     appeal of the listing) and `appealable`.
-- Super Admin (FORBIDDEN for anyone else, before anything is read; reason 5-500 characters as in
-- 0037; one audit chain row per decision):
--   core.admin_reports(cursor, page_size) -> open cases, oldest first: target snapshot, reason
--     counts, reporter count; reporters only as opaque per-case numbers (1, 2, ...).
--   core.admin_report_resolve(case_id, 'UPHELD' | 'DISMISSED', reason): UPHELD hides a published
--     product (a hidden one stays hidden, with this reason); DISMISSED restores a product this case
--     hid automatically (PUBLICATION_PAUSED while publication is off). A store case is recorded.
--   core.admin_appeal_resolve(appeal_id, 'UPHELD' | 'DENIED', reason): UPHELD restores a hidden
--     listing (PUBLISHED, stock and counters untouched; the open report case of the product is
--     closed DISMISSED) or returns a rejected one to DRAFT for resubmission.
--   core.admin_moderation_queue now fills `appeals` (open appeals, oldest first) with the
--     original decision, its reason and the evidence (screening reasons, report reason counts).
--
-- What the database takes on the web server's word: the screening flags of a report's detail
-- (advisory codes shown to the Super Admin; the detail is stored as given). Everything else is
-- checked here.

-- ---------------------------------------------------------------- records
CREATE TABLE core.listing_hide (
  id          uuid PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES core.product (id),
  reason      text CHECK (reason IS NULL OR char_length(reason) <= 500),
  hidden_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  lifted_at   timestamptz,
  CHECK (lifted_at IS NULL OR lifted_at >= hidden_at)
);
CREATE UNIQUE INDEX listing_hide_one_open ON core.listing_hide (product_id) WHERE lifted_at IS NULL;
CREATE INDEX listing_hide_product ON core.listing_hide (product_id, hidden_at);

CREATE TABLE core.report_case (
  id                uuid PRIMARY KEY,
  target_type       text NOT NULL CHECK (target_type IN ('PRODUCT', 'STORE')),
  product_id        uuid REFERENCES core.product (id),
  company_id        uuid NOT NULL REFERENCES core.company (id),
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UPHELD', 'DISMISSED')),
  auto_hide_id      uuid REFERENCES core.listing_hide (id),
  opened_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at       timestamptz,
  resolution_reason text CHECK (resolution_reason IS NULL OR char_length(resolution_reason) <= 500),
  CHECK ((target_type = 'PRODUCT') = (product_id IS NOT NULL)),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX report_case_open_product ON core.report_case (product_id)
  WHERE status = 'OPEN' AND target_type = 'PRODUCT';
CREATE UNIQUE INDEX report_case_open_store ON core.report_case (company_id)
  WHERE status = 'OPEN' AND target_type = 'STORE';
CREATE INDEX report_case_open ON core.report_case (opened_at, id) WHERE status = 'OPEN';

CREATE TABLE core.report (
  id               uuid PRIMARY KEY,
  reference        text NOT NULL UNIQUE CHECK (reference ~ '^R-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$'),
  case_id          uuid NOT NULL REFERENCES core.report_case (id),
  reporter_user_id uuid NOT NULL REFERENCES core.user_profile (id),
  reason           text NOT NULL CHECK (reason IN ('SEXUAL', 'HATE', 'HARASSMENT', 'VIOLENCE', 'SCAM_OR_PAYMENT',
                                                   'PERSONAL_INFO', 'IMPERSONATION', 'COPYRIGHT', 'OTHER')),
  detail           text CHECK (detail IS NULL OR (char_length(detail) BETWEEN 1 AND 500
                                                  AND detail !~ '[\x01-\x09\x0b-\x1f\x7f]')),
  detail_flags     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(detail_flags) = 'array'),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, reporter_user_id)
);
CREATE INDEX report_reporter ON core.report (reporter_user_id, created_at);

CREATE TABLE core.appeal (
  id              uuid PRIMARY KEY,
  product_id      uuid NOT NULL REFERENCES core.product (id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES core.company (id),
  kind            text NOT NULL CHECK (kind IN ('REJECTION', 'HIDE')),
  -- the moderation action appealed: once per action
  submission_id   uuid UNIQUE REFERENCES core.listing_submission (id) ON DELETE CASCADE,
  hide_id         uuid UNIQUE REFERENCES core.listing_hide (id),
  statement       text NOT NULL CHECK (char_length(statement) BETWEEN 20 AND 1000
                                       AND statement !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UPHELD', 'DENIED')),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at      timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 500),
  CHECK ((kind = 'REJECTION') = (submission_id IS NOT NULL)),
  CHECK ((kind = 'HIDE') = (hide_id IS NOT NULL)),
  CHECK ((status = 'OPEN') = (decided_at IS NULL))
);
CREATE INDEX appeal_open ON core.appeal (created_at, id) WHERE status = 'OPEN';
CREATE INDEX appeal_product ON core.appeal (product_id, created_at);

ALTER TABLE core.listing_hide ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.report_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.report ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.appeal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.listing_hide, core.report_case, core.report, core.appeal
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.listing_hide USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.report_case USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.report USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.appeal USING (false) WITH CHECK (false);

-- Reports, cases and hides are history: never deleted; a report never changes; a case and a hide
-- change only by being resolved or lifted, once.
CREATE FUNCTION core.guard_safety_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'report' THEN
    RAISE EXCEPTION 'a report never changes' USING ERRCODE = 'check_violation';
  ELSIF TG_TABLE_NAME = 'report_case' THEN
    IF OLD.status <> 'OPEN'
       OR (NEW.id, NEW.target_type, NEW.product_id, NEW.company_id, NEW.opened_at)
          IS DISTINCT FROM (OLD.id, OLD.target_type, OLD.product_id, OLD.company_id, OLD.opened_at)
       OR (OLD.auto_hide_id IS NOT NULL AND NEW.auto_hide_id IS DISTINCT FROM OLD.auto_hide_id) THEN
      RAISE EXCEPTION 'report case %: only an open case is resolved, once', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'listing_hide' THEN
    IF OLD.lifted_at IS NOT NULL
       OR (NEW.id, NEW.product_id, NEW.reason, NEW.hidden_at) IS DISTINCT FROM (OLD.id, OLD.product_id, OLD.reason, OLD.hidden_at) THEN
      RAISE EXCEPTION 'listing hide %: only lifted, once', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'appeal' THEN
    IF OLD.status <> 'OPEN'
       OR (NEW.id, NEW.product_id, NEW.company_id, NEW.kind, NEW.submission_id, NEW.hide_id, NEW.statement, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.product_id, OLD.company_id, OLD.kind, OLD.submission_id, OLD.hide_id,
                            OLD.statement, OLD.created_at) THEN
      RAISE EXCEPTION 'appeal %: only an open appeal is decided, once', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE UPDATE ON core.report FOR EACH ROW EXECUTE FUNCTION core.guard_safety_record();
CREATE TRIGGER guard BEFORE UPDATE ON core.report_case FOR EACH ROW EXECUTE FUNCTION core.guard_safety_record();
CREATE TRIGGER guard BEFORE UPDATE ON core.listing_hide FOR EACH ROW EXECUTE FUNCTION core.guard_safety_record();
CREATE TRIGGER guard BEFORE UPDATE ON core.appeal FOR EACH ROW EXECUTE FUNCTION core.guard_safety_record();
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.listing_hide', 'core.report_case', 'core.report'] LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.refuse_delete()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete()', t);
  END LOOP;
END $$;

-- Every move into HIDDEN is recorded (whoever made it: the Super Admin, the report safety net),
-- and lifted when the listing leaves HIDDEN.
CREATE FUNCTION core.record_listing_hide() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status = 'HIDDEN' AND OLD.status IS DISTINCT FROM 'HIDDEN' THEN
    INSERT INTO core.listing_hide (id, product_id, reason) VALUES (core.uuid_v7(), NEW.id, NEW.moderation_reason);
  ELSIF OLD.status = 'HIDDEN' AND NEW.status IS DISTINCT FROM 'HIDDEN' THEN
    UPDATE core.listing_hide h SET lifted_at = clock_timestamp() WHERE h.product_id = NEW.id AND h.lifted_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER record_hide AFTER UPDATE OF status ON core.product
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND 'HIDDEN' IN (OLD.status, NEW.status))
  EXECUTE FUNCTION core.record_listing_hide();

-- ---------------------------------------------------------------- helpers
-- A case reference: `R-` and ten symbols of the coupon alphabet (50 random bits from pgcrypto).
CREATE FUNCTION core.report_reference() RETURNS text
LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'R-' || substr(core.generate_coupon_code(), 1, 10)
$$;

-- The people on the selling side of a company (today its owner; teams arrive with brands).
CREATE FUNCTION core.company_party_ids(p_company uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(array_agg(c.owner_user_id), '{}'::uuid[]) FROM core.company c WHERE c.id = p_company
$$;

-- Distinct reporters of an open case that count towards the automatic hide: accounts at least
-- `report_reporter_min_age_hours` old, active, and not a party of the reported company.
CREATE FUNCTION core.report_qualifying_count(p_case uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(DISTINCT r.reporter_user_id)::int
    FROM core.report r
    JOIN core.report_case rc ON rc.id = r.case_id
    JOIN core.user_profile up ON up.id = r.reporter_user_id
   WHERE r.case_id = p_case AND rc.status = 'OPEN' AND up.status = 'ACTIVE'
     AND up.created_at <= clock_timestamp()
           - make_interval(hours => core.config_int(core.current_config_id(), ARRAY['report_reporter_min_age_hours'], 24)::int)
     AND NOT (r.reporter_user_id = ANY (core.company_party_ids(rc.company_id)))
$$;

-- {reasonCode: count} of a case's reports.
CREATE FUNCTION core.report_reason_counts(p_case uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(x.reason, x.n), '{}'::jsonb)
    FROM (SELECT r.reason, count(*) AS n FROM core.report r WHERE r.case_id = p_case GROUP BY r.reason) x
$$;

-- ---------------------------------------------------------------- reporting
CREATE FUNCTION core.report_create(p_target_type text, p_target_id uuid, p_reason text, p_detail text,
                                   p_detail_flags jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor     uuid := core.require_actor();
  v_cfg       int := core.current_config_id();
  v_detail    text := NULLIF(btrim(COALESCE(p_detail, '')), '');
  v_flags     jsonb := COALESCE(p_detail_flags, '[]'::jsonb);
  v_product   core.product;
  v_company   uuid;
  v_case      core.report_case;
  v_id        uuid := core.uuid_v7();
  v_reference text;
  v_created   timestamptz;
  v_tries     int := 0;
  v_hide      uuid;
  v_n         int;
BEGIN
  PERFORM ledger.require_read_committed();
  IF NOT EXISTS (SELECT 1 FROM ledger.ledger_account la WHERE la.user_id = v_actor AND la.type = 'USER') THEN
    PERFORM core.fail('ONBOARDING_REQUIRED', 'finish onboarding first');
  END IF;
  IF p_target_type IS NULL OR p_target_type NOT IN ('PRODUCT', 'STORE') OR p_target_id IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a report names a PRODUCT or a STORE');
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('SEXUAL', 'HATE', 'HARASSMENT', 'VIOLENCE', 'SCAM_OR_PAYMENT',
                                          'PERSONAL_INFO', 'IMPERSONATION', 'COPYRIGHT', 'OTHER') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown report reason');
  END IF;
  IF v_detail IS NOT NULL AND (char_length(v_detail) > 500 OR v_detail ~ '[\x01-\x09\x0b-\x1f\x7f]') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a report detail is at most 500 characters, without control characters');
  END IF;
  IF jsonb_typeof(v_flags) <> 'array' OR jsonb_array_length(v_flags) > 20 OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_flags) f WHERE jsonb_typeof(f) <> 'string' OR f #>> '{}' !~ '^[A-Z_]{2,32}$') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'detail flags are screening codes');
  END IF;

  -- the actor's reports, one at a time: the hourly limit is counted on committed rows
  PERFORM core.lock_actor('core.report', v_actor);
  IF (SELECT count(*) FROM core.report r
       WHERE r.reporter_user_id = v_actor AND r.created_at > clock_timestamp() - interval '1 hour')
     >= core.config_int(v_cfg, ARRAY['reports_per_hour'], 5) THEN
    PERFORM core.fail('REPORT_LIMIT', 'you have sent as many reports as you may this hour; try again later');
  END IF;

  IF p_target_type = 'PRODUCT' THEN
    -- #6 the product: reports on one product, and its automatic hide, one at a time
    SELECT * INTO v_product FROM core.product p
     WHERE p.id = p_target_id AND p.seller_type = 'USER' AND p.status = 'PUBLISHED'
     FOR NO KEY UPDATE;
    IF NOT FOUND OR v_product.status <> 'PUBLISHED' THEN
      PERFORM core.fail('NOT_FOUND', 'product not found');
    END IF;
    v_company := v_product.company_id;
  ELSE
    SELECT c.id INTO v_company FROM core.company c WHERE c.id = p_target_id AND c.handle IS NOT NULL;
    IF v_company IS NULL THEN
      PERFORM core.fail('NOT_FOUND', 'store not found');
    END IF;
  END IF;
  IF v_actor = ANY (core.company_party_ids(v_company)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'you cannot report your own store or listing');
  END IF;

  -- the target's open case (created on its first report), held while the report joins it
  LOOP
    SELECT * INTO v_case FROM core.report_case rc
     WHERE rc.status = 'OPEN' AND rc.target_type = p_target_type
       AND CASE WHEN p_target_type = 'PRODUCT' THEN rc.product_id = p_target_id ELSE rc.company_id = v_company END
     FOR SHARE;
    EXIT WHEN FOUND AND v_case.status = 'OPEN';
    INSERT INTO core.report_case (id, target_type, product_id, company_id)
    VALUES (core.uuid_v7(), p_target_type, CASE WHEN p_target_type = 'PRODUCT' THEN p_target_id END, v_company)
    ON CONFLICT DO NOTHING;
  END LOOP;
  IF EXISTS (SELECT 1 FROM core.report r WHERE r.case_id = v_case.id AND r.reporter_user_id = v_actor) THEN
    PERFORM core.fail('ALREADY_REPORTED', 'you have already reported this; we are looking at it');
  END IF;

  LOOP
    v_reference := core.report_reference();
    BEGIN
      INSERT INTO core.report (id, reference, case_id, reporter_user_id, reason, detail, detail_flags)
      VALUES (v_id, v_reference, v_case.id, v_actor, p_reason, v_detail, v_flags)
      RETURNING created_at INTO v_created;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_tries := v_tries + 1;
      IF v_tries >= 5 THEN RAISE; END IF;
    END;
  END LOOP;

  -- the safety net, in this same transaction
  IF p_target_type = 'PRODUCT' THEN
    v_n := core.report_qualifying_count(v_case.id);
    IF v_n >= core.config_int(v_cfg, ARRAY['report_hide_threshold'], 3) THEN
      UPDATE core.product p SET status = 'HIDDEN', moderation_reason = 'Hidden pending review',
                                updated_at = clock_timestamp()
       WHERE p.id = v_product.id;
      SELECT h.id INTO v_hide FROM core.listing_hide h WHERE h.product_id = v_product.id AND h.lifted_at IS NULL;
      UPDATE core.report_case rc SET auto_hide_id = v_hide WHERE rc.id = v_case.id;
      -- ids and counts only: never a reporter (invariant 8)
      INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
      VALUES (core.uuid_v7(), 'listing_hidden', v_product.id, jsonb_build_object(
        'productId', v_product.id, 'companyId', v_company, 'cause', 'REPORTS', 'caseId', v_case.id), 1);
      PERFORM audit.append_chained(NULL, 'SYSTEM', 'listing.auto_hide', 'product', v_product.id::text,
        format('%s independent reports', v_n), jsonb_build_object('caseId', v_case.id, 'qualifyingReporters', v_n));
    END IF;
  END IF;
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('reference', v_reference, 'targetType', p_target_type, 'targetId', p_target_id,
                            'reason', p_reason, 'status', 'OPEN', 'createdAt', v_created);
END $$;

-- The actor's own reports, newest first (at most 100): reference, target, reason, case status.
CREATE FUNCTION core.my_reports() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('items', COALESCE(jsonb_agg(x.j ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb))
    FROM (SELECT r.id, r.created_at, jsonb_build_object(
                   'reference', r.reference, 'targetType', rc.target_type,
                   'targetId', COALESCE(rc.product_id, rc.company_id), 'reason', r.reason,
                   'status', rc.status, 'createdAt', r.created_at, 'resolvedAt', rc.resolved_at) AS j
            FROM core.report r JOIN core.report_case rc ON rc.id = r.case_id
           WHERE r.reporter_user_id = core.require_actor()
           ORDER BY r.created_at DESC, r.id DESC LIMIT 100) x
$$;

-- ---------------------------------------------------------------- Super Admin: report cases
CREATE FUNCTION core.report_case_json(rc core.report_case) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'caseId', rc.id, 'targetType', rc.target_type, 'status', rc.status, 'openedAt', rc.opened_at,
    'autoHidden', rc.auto_hide_id IS NOT NULL,
    'target', CASE WHEN rc.target_type = 'PRODUCT' THEN (
        SELECT jsonb_build_object('productId', p.id, 'status', p.status, 'name', v.name,
                                  'pricePaise', v.price_paise::text, 'templateId', v.template_id,
                                  'store', jsonb_build_object('companyId', c.id, 'handle', c.handle, 'displayName', c.name))
          FROM core.product p JOIN core.company c ON c.id = p.company_id
          LEFT JOIN core.product_version v ON v.id = p.current_version_id
         WHERE p.id = rc.product_id)
      ELSE (SELECT jsonb_build_object('companyId', c.id, 'handle', c.handle, 'displayName', c.name,
                                      'description', c.description)
              FROM core.company c WHERE c.id = rc.company_id) END,
    'reasonCounts', core.report_reason_counts(rc.id),
    'reporterCount', (SELECT count(*) FROM core.report r WHERE r.case_id = rc.id),
    'qualifyingReporterCount', core.report_qualifying_count(rc.id),
    -- reporters only as opaque numbers within this case, in the order they reported
    'reports', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'reporter', x.n, 'reason', x.reason, 'detail', x.detail, 'detailFlags', x.detail_flags,
                   'createdAt', x.created_at) ORDER BY x.n), '[]'::jsonb)
                  FROM (SELECT r.reason, r.detail, r.detail_flags, r.created_at,
                               row_number() OVER (ORDER BY r.created_at, r.id) AS n
                          FROM core.report r WHERE r.case_id = rc.id) x))
$$;

CREATE FUNCTION core.admin_reports(p_cursor uuid, p_page_size int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := core.admin_actor();
  v_size  int := core.page_size(p_page_size);
  v_items jsonb;
  v_ids   uuid[];
BEGIN
  SELECT COALESCE(jsonb_agg(core.report_case_json(x) ORDER BY x.opened_at, x.id), '[]'::jsonb),
         array_agg(x.id ORDER BY x.opened_at, x.id)
    INTO v_items, v_ids
    FROM (SELECT rc.* FROM core.report_case rc
           WHERE rc.status = 'OPEN'
             AND (p_cursor IS NULL OR (rc.opened_at, rc.id) > (SELECT o.opened_at, o.id FROM core.report_case o
                                                                WHERE o.id = p_cursor))
           ORDER BY rc.opened_at, rc.id LIMIT v_size) x;
  RETURN jsonb_build_object('items', v_items,
    'nextCursor', CASE WHEN cardinality(v_ids) = v_size THEN v_ids[v_size] END);
END $$;

CREATE FUNCTION core.admin_report_resolve(p_case uuid, p_outcome text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor   uuid := core.admin_actor();
  v_reason  text := core.admin_reason(p_reason);
  v_case    core.report_case;
  v_p       core.product;
  v_effect  text := 'NONE';
BEGIN
  PERFORM ledger.require_read_committed();
  IF p_outcome IS NULL OR p_outcome NOT IN ('UPHELD', 'DISMISSED') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'outcome is UPHELD or DISMISSED');
  END IF;
  SELECT * INTO v_case FROM core.report_case rc WHERE rc.id = p_case;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'report case not found');
  END IF;
  IF v_case.product_id IS NOT NULL THEN
    v_p := core.admin_listing_locked(v_case.product_id);   -- #4 company, #5 warehouses, #6 product
  END IF;
  SELECT * INTO v_case FROM core.report_case rc WHERE rc.id = p_case FOR UPDATE;
  IF v_case.status <> 'OPEN' THEN
    PERFORM core.fail('CONFLICT', 'this case is already resolved');
  END IF;
  IF v_case.product_id IS NOT NULL AND p_outcome = 'UPHELD' THEN
    IF v_p.status = 'PUBLISHED' THEN
      UPDATE core.product p SET status = 'HIDDEN', moderation_reason = v_reason, updated_at = clock_timestamp()
       WHERE p.id = v_p.id;
      INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
      VALUES (core.uuid_v7(), 'listing_hidden', v_p.id, jsonb_build_object(
        'productId', v_p.id, 'companyId', v_p.company_id, 'cause', 'REPORT_UPHELD', 'caseId', v_case.id), 1);
      v_effect := 'HIDDEN';
    ELSIF v_p.status = 'HIDDEN' THEN
      UPDATE core.product p SET moderation_reason = v_reason, updated_at = clock_timestamp() WHERE p.id = v_p.id;
      v_effect := 'KEPT_HIDDEN';
    END IF;
  ELSIF v_case.product_id IS NOT NULL AND p_outcome = 'DISMISSED' AND v_p.status = 'HIDDEN'
        AND v_case.auto_hide_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM core.listing_hide h WHERE h.id = v_case.auto_hide_id AND h.lifted_at IS NULL) THEN
    IF NOT core.switch_on('publication') THEN
      PERFORM core.fail('PUBLICATION_PAUSED', 'publication is paused; switch it on first');
    END IF;
    UPDATE core.product p SET status = 'PUBLISHED', moderation_reason = NULL, updated_at = clock_timestamp()
     WHERE p.id = v_p.id;
    INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
    VALUES (core.uuid_v7(), 'listing_restored', v_p.id, jsonb_build_object(
      'productId', v_p.id, 'companyId', v_p.company_id, 'cause', 'REPORT_DISMISSED', 'caseId', v_case.id), 1);
    v_effect := 'RESTORED';
  END IF;
  UPDATE core.report_case rc SET status = p_outcome, resolved_at = clock_timestamp(), resolution_reason = v_reason
   WHERE rc.id = v_case.id;
  PERFORM core.admin_audit(v_actor, CASE p_outcome WHEN 'UPHELD' THEN 'report.uphold' ELSE 'report.dismiss' END,
                           'report_case', v_case.id::text, v_reason,
                           jsonb_build_object('targetType', v_case.target_type, 'productId', v_case.product_id,
                                              'companyId', v_case.company_id, 'effect', v_effect));
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('caseId', v_case.id, 'outcome', p_outcome, 'effect', v_effect,
    'productStatus', (SELECT p.status FROM core.product p WHERE p.id = v_case.product_id));
END $$;

-- ---------------------------------------------------------------- appeals
-- The moderation action a listing's owner may appeal now: {kind, submissionId | hideId}, or NULL.
CREATE FUNCTION core.appealable_action(p core.product) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN p.status = 'HIDDEN' THEN (
      SELECT jsonb_build_object('kind', 'HIDE', 'hideId', h.id, 'reason', h.reason, 'at', h.hidden_at)
        FROM core.listing_hide h WHERE h.product_id = p.id AND h.lifted_at IS NULL)
    WHEN p.status = 'REJECTED' THEN (
      SELECT jsonb_build_object('kind', 'REJECTION', 'submissionId', s.id, 'reason', s.decision_reason, 'at', s.decided_at)
        FROM core.listing_submission s
       WHERE s.product_id = p.id AND s.kind = 'FIRST' AND s.state = 'REJECTED'
         AND s.decided_by IN ('SCREENING', 'SUPER_ADMIN')
       ORDER BY s.decided_at DESC NULLS LAST, s.id DESC LIMIT 1)
  END
$$;

CREATE FUNCTION core.appeal_json(a core.appeal) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'appealId', a.id, 'productId', a.product_id, 'kind', a.kind, 'status', a.status, 'statement', a.statement,
    'createdAt', a.created_at, 'decidedAt', a.decided_at, 'decisionReason', a.decision_reason,
    'productName', (SELECT v.name FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
                     WHERE p.id = a.product_id))
$$;

CREATE FUNCTION core.appeal_create(p_product uuid, p_statement text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company   core.company := core.listing_studio();
  v_p         core.product := core.listing_own_locked(v_company.id, p_product);
  v_statement text := btrim(COALESCE(p_statement, ''));
  v_action    jsonb;
  v_a         core.appeal;
BEGIN
  IF char_length(v_statement) NOT BETWEEN 20 AND 1000 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'an appeal statement is 20 to 1,000 characters');
  END IF;
  IF v_statement ~ '[\x01-\x09\x0b-\x1f\x7f]' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'an appeal statement may not contain control characters');
  END IF;
  v_action := core.appealable_action(v_p);
  IF v_action IS NULL THEN
    PERFORM core.fail('NOT_APPEALABLE', 'only a listing rejected or hidden by moderation can be appealed');
  END IF;
  IF EXISTS (SELECT 1 FROM core.appeal a
              WHERE a.submission_id = (v_action ->> 'submissionId')::uuid OR a.hide_id = (v_action ->> 'hideId')::uuid) THEN
    PERFORM core.fail('APPEAL_EXISTS', 'this decision has already been appealed');
  END IF;
  INSERT INTO core.appeal (id, product_id, company_id, kind, submission_id, hide_id, statement)
  VALUES (core.uuid_v7(), v_p.id, v_company.id, v_action ->> 'kind', (v_action ->> 'submissionId')::uuid,
          (v_action ->> 'hideId')::uuid, v_statement)
  RETURNING * INTO v_a;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'appeal_created', v_a.id, jsonb_build_object(
    'appealId', v_a.id, 'productId', v_p.id, 'companyId', v_company.id, 'kind', v_a.kind), 1);
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('appeal', core.appeal_json(v_a));
END $$;

-- The owner's appeals, newest first (at most 100).
CREATE FUNCTION core.my_appeals() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('items', COALESCE(jsonb_agg(core.appeal_json(x) ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb))
    FROM (SELECT a.* FROM core.appeal a JOIN core.company c ON c.id = a.company_id
           WHERE c.owner_user_id = core.require_actor()
           ORDER BY a.created_at DESC, a.id DESC LIMIT 100) x
$$;

-- The studio's product detail gains the listing's latest appeal and whether it can be appealed now.
ALTER FUNCTION core.my_product(uuid) RENAME TO my_product_base;
REVOKE ALL ON FUNCTION core.my_product_base(uuid) FROM PUBLIC, app_web;
CREATE FUNCTION core.my_product(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_base   jsonb := core.my_product_base(p_product);   -- NOT_FOUND for anyone else's listing
  v_p      core.product;
  v_action jsonb;
BEGIN
  SELECT * INTO v_p FROM core.product p WHERE p.id = p_product;
  v_action := core.appealable_action(v_p);
  RETURN v_base || jsonb_build_object(
    'appeal', (SELECT core.appeal_json(a) FROM core.appeal a WHERE a.product_id = v_p.id
                ORDER BY a.created_at DESC, a.id DESC LIMIT 1),
    'appealable', v_action IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM core.appeal a WHERE a.submission_id = (v_action ->> 'submissionId')::uuid
                                      OR a.hide_id = (v_action ->> 'hideId')::uuid));
END $$;

CREATE FUNCTION core.admin_appeal_resolve(p_appeal uuid, p_outcome text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor  uuid := core.admin_actor();
  v_reason text := core.admin_reason(p_reason);
  v_a      core.appeal;
  v_p      core.product;
  v_effect text := 'NONE';
BEGIN
  PERFORM ledger.require_read_committed();
  IF p_outcome IS NULL OR p_outcome NOT IN ('UPHELD', 'DENIED') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'outcome is UPHELD or DENIED');
  END IF;
  SELECT * INTO v_a FROM core.appeal a WHERE a.id = p_appeal;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'appeal not found');
  END IF;
  v_p := core.admin_listing_locked(v_a.product_id);   -- #4 company, #5 warehouses, #6 product
  SELECT * INTO v_a FROM core.appeal a WHERE a.id = p_appeal FOR UPDATE;
  IF v_a.status <> 'OPEN' THEN
    PERFORM core.fail('CONFLICT', 'this appeal is already decided');
  END IF;
  IF p_outcome = 'UPHELD' THEN
    IF v_a.kind = 'HIDE' AND v_p.status = 'HIDDEN'
       AND EXISTS (SELECT 1 FROM core.listing_hide h WHERE h.id = v_a.hide_id AND h.lifted_at IS NULL) THEN
      IF NOT core.switch_on('publication') THEN
        PERFORM core.fail('PUBLICATION_PAUSED', 'publication is paused; switch it on first');
      END IF;
      -- back on sale as it was: the status only; stock, counters and orders are untouched
      UPDATE core.product p SET status = 'PUBLISHED', moderation_reason = NULL, updated_at = clock_timestamp()
       WHERE p.id = v_p.id;
      -- the reports that led here are answered by this decision
      UPDATE core.report_case rc SET status = 'DISMISSED', resolved_at = clock_timestamp(),
                                     resolution_reason = v_reason
       WHERE rc.product_id = v_p.id AND rc.status = 'OPEN';
      INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
      VALUES (core.uuid_v7(), 'listing_restored', v_p.id, jsonb_build_object(
        'productId', v_p.id, 'companyId', v_p.company_id, 'cause', 'APPEAL_UPHELD', 'appealId', v_a.id), 1);
      v_effect := 'RESTORED';
    ELSIF v_a.kind = 'REJECTION' AND v_p.status = 'REJECTED' THEN
      UPDATE core.product p SET status = 'DRAFT', moderation_reason = NULL, updated_at = clock_timestamp()
       WHERE p.id = v_p.id;
      v_effect := 'RETURNED_TO_DRAFT';
    END IF;
  END IF;
  UPDATE core.appeal a SET status = p_outcome, decided_at = clock_timestamp(), decision_reason = v_reason
   WHERE a.id = v_a.id;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'appeal_decided', v_a.id, jsonb_build_object(
    'appealId', v_a.id, 'productId', v_p.id, 'companyId', v_p.company_id, 'outcome', p_outcome, 'effect', v_effect), 1);
  PERFORM core.admin_audit(v_actor, CASE p_outcome WHEN 'UPHELD' THEN 'appeal.uphold' ELSE 'appeal.deny' END,
                           'appeal', v_a.id::text, v_reason,
                           jsonb_build_object('productId', v_p.id, 'kind', v_a.kind, 'effect', v_effect));
  PERFORM core.listing_checks();
  RETURN jsonb_build_object('appealId', v_a.id, 'outcome', p_outcome, 'effect', v_effect, 'productId', v_p.id,
    'productStatus', (SELECT p.status FROM core.product p WHERE p.id = v_p.id));
END $$;

-- 0037's queue, with the open appeals after the reviews: each with the original decision, its
-- reason and the evidence (screening reasons; the report case's reason counts).
CREATE OR REPLACE FUNCTION core.admin_moderation_queue(p_cursor uuid, p_page_size int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor   uuid := core.admin_actor();
  v_size    int := core.page_size(p_page_size);
  v_items   jsonb;
  v_ids     uuid[];
  v_appeals jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.submitted_at, x.id), '[]'::jsonb), array_agg(x.id ORDER BY x.submitted_at, x.id)
    INTO v_items, v_ids
    FROM (SELECT s.id, s.submitted_at, jsonb_build_object(
                   'submissionId', s.id, 'productId', s.product_id, 'versionId', s.version_id, 'kind', s.kind,
                   'submittedAt', s.submitted_at, 'reasons', s.reasons,
                   'store', jsonb_build_object('handle', c.handle, 'displayName', c.name),
                   'category', p.category, 'inventoryMode', p.inventory_mode, 'productStatus', p.status,
                   'version', core.listing_version_json(v)) AS j
            FROM core.listing_submission s
            JOIN core.product p ON p.id = s.product_id
            JOIN core.company c ON c.id = s.company_id
            JOIN core.product_version v ON v.id = s.version_id
           WHERE s.state = 'NEEDS_REVIEW'
             AND (p_cursor IS NULL OR (s.submitted_at, s.id) > (SELECT o.submitted_at, o.id FROM core.listing_submission o
                                                                  WHERE o.id = p_cursor))
           ORDER BY s.submitted_at, s.id LIMIT v_size) x;
  SELECT COALESCE(jsonb_agg(y.j ORDER BY y.created_at, y.id), '[]'::jsonb) INTO v_appeals
    FROM (SELECT a.id, a.created_at, jsonb_build_object(
                   'appealId', a.id, 'productId', a.product_id, 'kind', a.kind, 'statement', a.statement,
                   'createdAt', a.created_at, 'productStatus', p.status,
                   'store', jsonb_build_object('handle', c.handle, 'displayName', c.name),
                   'version', (SELECT core.listing_version_json(v) FROM core.product_version v WHERE v.id = p.current_version_id),
                   'decision', CASE a.kind
                     WHEN 'HIDE' THEN (SELECT jsonb_build_object('action', 'HIDDEN', 'reason', h.reason, 'at', h.hidden_at,
                                                                 'by', CASE WHEN EXISTS (SELECT 1 FROM core.report_case rc
                                                                                          WHERE rc.auto_hide_id = h.id)
                                                                            THEN 'REPORTS' ELSE 'SUPER_ADMIN' END)
                                         FROM core.listing_hide h WHERE h.id = a.hide_id)
                     ELSE (SELECT jsonb_build_object('action', 'REJECTED', 'reason', s.decision_reason, 'at', s.decided_at,
                                                     'by', s.decided_by)
                             FROM core.listing_submission s WHERE s.id = a.submission_id) END,
                   'evidence', jsonb_build_object(
                     'reasons', COALESCE((SELECT s.reasons FROM core.listing_submission s WHERE s.id = a.submission_id), '[]'::jsonb),
                     'reports', (SELECT jsonb_build_object('caseId', rc.id, 'reasonCounts', core.report_reason_counts(rc.id),
                                                           'reporterCount', (SELECT count(*) FROM core.report r WHERE r.case_id = rc.id))
                                   FROM core.report_case rc
                                  WHERE rc.product_id = a.product_id AND (rc.status = 'OPEN' OR rc.auto_hide_id = a.hide_id)
                                  ORDER BY rc.opened_at DESC LIMIT 1))) AS j
            FROM core.appeal a
            JOIN core.product p ON p.id = a.product_id
            JOIN core.company c ON c.id = a.company_id
           WHERE a.status = 'OPEN'
           ORDER BY a.created_at, a.id LIMIT v_size) y;
  RETURN jsonb_build_object('items', v_items,
    'nextCursor', CASE WHEN cardinality(v_ids) = v_size THEN v_ids[v_size] END,
    'appeals', v_appeals);
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.guard_safety_record(), core.record_listing_hide(), core.report_reference(),
  core.company_party_ids(uuid), core.report_qualifying_count(uuid), core.report_reason_counts(uuid),
  core.report_create(text, uuid, text, text, jsonb), core.my_reports(), core.report_case_json(core.report_case),
  core.admin_reports(uuid, int), core.admin_report_resolve(uuid, text, text), core.appealable_action(core.product),
  core.appeal_json(core.appeal), core.appeal_create(uuid, text), core.my_appeals(), core.my_product(uuid),
  core.admin_appeal_resolve(uuid, text, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.report_create(text, uuid, text, text, jsonb), core.my_reports(),
  core.admin_reports(uuid, int), core.admin_report_resolve(uuid, text, text), core.appeal_create(uuid, text),
  core.my_appeals(), core.my_product(uuid), core.admin_appeal_resolve(uuid, text, text)
TO app_web;
