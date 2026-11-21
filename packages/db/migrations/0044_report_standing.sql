-- Report abuse (sixth security review, major 1). Three ordinary accounts could hide any listing
-- again and again: the same three re-reported after an upheld appeal, and a reporter's age was
-- checked when the hide was evaluated, so young accounts "aged into" a hide they had reported
-- long before. The automatic hide now counts a report only when, AT THE TIME OF THE REPORT (stored
-- on the report row, never re-evaluated in the reporter's favour):
--   (a) reporter_aged:        the account was at least `report_reporter_min_age_hours` (24) old;
--   (e) reporter_established: the account was at least `report_established_age_days` (7) old, or
--                             had made at least `report_established_min_purchases` (1) completed
--                             purchase (raises the cost of throwaway accounts);
--   (c) reporter_in_standing: fewer than `report_dismissed_max` (2) of the reporter's reports were
--                             in cases DISMISSED (or cleared by an upheld appeal) in the last
--                             `report_standing_days` (30). A reporter out of standing may still
--                             report: the case opens for the Super Admin, it just does not count.
--                             Standing is ALSO checked again when the hide is evaluated.
-- and, when the hide is evaluated:
--   (d) the reporter has not contributed to another automatic hide in the last
--       `report_hide_cooldown_hours` (24), across all products (core.auto_hide_contribution);
--   (b) the product has had no report case DISMISSED and no appeal against a hide UPHELD in the
--       last `report_auto_hide_exempt_days` (30): it is exempt from AUTOMATIC hiding (reports still
--       open a case for the Super Admin); and the reporters of such a cleared case cannot report
--       the same product again for `report_rereport_block_days` (90) (ALREADY_REPORTED).
-- Clearances are recorded in core.report_clearance (append-only, owner-only): by a trigger on every
-- move of a report case to DISMISSED (any writer), and by core.admin_appeal_resolve for the cases
-- behind a hide whose appeal is upheld (core.report_case_hide links a case to the hide it caused).
--
-- Reports made before this migration carry false flags: they never count towards a hide.
--
-- Also (major 4): the Super Admin's restore through a dismissed case or an upheld appeal works while
-- the `publication` switch is off; the switch only stops automatic publication by screening.

-- ---------------------------------------------------------------- the report row's facts
ALTER TABLE core.report
  ADD COLUMN reporter_aged        boolean NOT NULL DEFAULT false,
  ADD COLUMN reporter_established boolean NOT NULL DEFAULT false,
  ADD COLUMN reporter_in_standing boolean NOT NULL DEFAULT false;
-- every new report states them explicitly (core.report_create); no silent default
ALTER TABLE core.report
  ALTER COLUMN reporter_aged DROP DEFAULT,
  ALTER COLUMN reporter_established DROP DEFAULT,
  ALTER COLUMN reporter_in_standing DROP DEFAULT;

-- ---------------------------------------------------------------- records
-- A case whose reports were found wanting: dismissed, or behind a hide whose appeal was upheld.
CREATE TABLE core.report_clearance (
  case_id    uuid PRIMARY KEY REFERENCES core.report_case (id),
  product_id uuid REFERENCES core.product (id),
  cause      text NOT NULL CHECK (cause IN ('CASE_DISMISSED', 'APPEAL_UPHELD')),
  cleared_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX report_clearance_product ON core.report_clearance (product_id, cleared_at);
CREATE INDEX report_clearance_at ON core.report_clearance (cleared_at);

-- The hide a case caused (an automatic hide, or the Super Admin upholding the case).
CREATE TABLE core.report_case_hide (
  case_id uuid PRIMARY KEY REFERENCES core.report_case (id),
  hide_id uuid NOT NULL REFERENCES core.listing_hide (id)
);
CREATE INDEX report_case_hide_hide ON core.report_case_hide (hide_id);

-- The reporters whose reports made an automatic hide happen.
CREATE TABLE core.auto_hide_contribution (
  hide_id          uuid NOT NULL REFERENCES core.listing_hide (id),
  reporter_user_id uuid NOT NULL REFERENCES core.user_profile (id),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (hide_id, reporter_user_id)
);
CREATE INDEX auto_hide_contribution_reporter ON core.auto_hide_contribution (reporter_user_id, created_at);

ALTER TABLE core.report_clearance ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.report_case_hide ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.auto_hide_contribution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.report_clearance, core.report_case_hide, core.auto_hide_contribution
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.report_clearance USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.report_case_hide USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.auto_hide_contribution USING (false) WITH CHECK (false);

-- History: never changed (core.refuse_change, 0035), never deleted.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.report_clearance', 'core.report_case_hide', 'core.auto_hide_contribution'] LOOP
    EXECUTE format('CREATE TRIGGER no_update BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.refuse_change()', t);
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.refuse_delete()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete()', t);
  END LOOP;
END $$;

-- Every dismissal of a case clears it (any writer).
CREATE FUNCTION core.record_case_clearance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO core.report_clearance (case_id, product_id, cause, cleared_at)
  VALUES (NEW.id, NEW.product_id, 'CASE_DISMISSED', COALESCE(NEW.resolved_at, clock_timestamp()))
  ON CONFLICT (case_id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER record_clearance AFTER UPDATE OF status ON core.report_case
  FOR EACH ROW WHEN (OLD.status = 'OPEN' AND NEW.status = 'DISMISSED')
  EXECUTE FUNCTION core.record_case_clearance();

-- cases dismissed before this migration are clearances too
INSERT INTO core.report_clearance (case_id, product_id, cause, cleared_at)
SELECT rc.id, rc.product_id, 'CASE_DISMISSED', rc.resolved_at FROM core.report_case rc WHERE rc.status = 'DISMISSED';
INSERT INTO core.report_case_hide (case_id, hide_id)
SELECT rc.id, rc.auto_hide_id FROM core.report_case rc WHERE rc.auto_hide_id IS NOT NULL;

-- ---------------------------------------------------------------- rules
CREATE FUNCTION core.report_rule(p_key text, p_default bigint) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.config_int(core.current_config_id(), ARRAY[p_key], p_default)::int
$$;

-- (c) Whether the user is in good standing as a reporter now.
CREATE FUNCTION core.report_in_standing(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) < core.report_rule('report_dismissed_max', 2)
    FROM core.report r JOIN core.report_clearance cl ON cl.case_id = r.case_id
   WHERE r.reporter_user_id = p_user
     AND cl.cleared_at > clock_timestamp() - make_interval(days => core.report_rule('report_standing_days', 30))
$$;

-- (d) Whether the user's reports already made an automatic hide happen within the cooldown.
CREATE FUNCTION core.report_hide_spent(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.auto_hide_contribution c
                  WHERE c.reporter_user_id = p_user
                    AND c.created_at > clock_timestamp()
                          - make_interval(hours => core.report_rule('report_hide_cooldown_hours', 24)))
$$;

-- (b) Whether the product is exempt from automatic hiding now.
CREATE FUNCTION core.report_hide_exempt(p_product uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.report_clearance cl
                  WHERE cl.product_id = p_product
                    AND cl.cleared_at > clock_timestamp()
                          - make_interval(days => core.report_rule('report_auto_hide_exempt_days', 30)))
$$;

-- The reporters of an open case whose reports count towards the automatic hide now.
CREATE FUNCTION core.report_qualifying_reporters(p_case uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT r.reporter_user_id
    FROM core.report r
    JOIN core.report_case rc ON rc.id = r.case_id
    JOIN core.user_profile up ON up.id = r.reporter_user_id
   WHERE r.case_id = p_case AND rc.status = 'OPEN' AND up.status = 'ACTIVE'
     AND r.reporter_aged AND r.reporter_established AND r.reporter_in_standing
     AND core.report_in_standing(r.reporter_user_id)
     AND NOT core.report_hide_spent(r.reporter_user_id)
     AND NOT (r.reporter_user_id = ANY (core.company_party_ids(rc.company_id)))
$$;

CREATE OR REPLACE FUNCTION core.report_qualifying_count(p_case uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*)::int FROM core.report_qualifying_reporters(p_case)
$$;

-- ---------------------------------------------------------------- reporting
CREATE OR REPLACE FUNCTION core.report_create(p_target_type text, p_target_id uuid, p_reason text, p_detail text,
                                              p_detail_flags jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor       uuid := core.require_actor();
  v_cfg         int := core.current_config_id();
  v_detail      text := NULLIF(btrim(COALESCE(p_detail, '')), '');
  v_flags       jsonb := COALESCE(p_detail_flags, '[]'::jsonb);
  v_product     core.product;
  v_company     uuid;
  v_case        core.report_case;
  v_id          uuid := core.uuid_v7();
  v_reference   text;
  v_created     timestamptz;
  v_tries       int := 0;
  v_hide        uuid;
  v_n           int;
  v_joined      timestamptz;
  v_aged        boolean;
  v_established boolean;
  v_standing    boolean;
  v_qual        uuid[];
  v_r           uuid;
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
  -- (b) a reporter of a cleared case does not report the same product again for a while
  IF p_target_type = 'PRODUCT' AND EXISTS (
       SELECT 1 FROM core.report_clearance cl JOIN core.report r ON r.case_id = cl.case_id
        WHERE cl.product_id = p_target_id AND r.reporter_user_id = v_actor
          AND cl.cleared_at > clock_timestamp() - make_interval(days => core.report_rule('report_rereport_block_days', 90))) THEN
    PERFORM core.fail('ALREADY_REPORTED', 'you have already reported this; we looked at it');
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

  -- (a), (e), (c): the reporter's standing at the time of the report, kept with the report
  SELECT up.created_at INTO v_joined FROM core.user_profile up WHERE up.id = v_actor;
  v_aged := v_joined <= clock_timestamp()
              - make_interval(hours => core.report_rule('report_reporter_min_age_hours', 24));
  v_established := v_joined <= clock_timestamp()
                     - make_interval(days => core.report_rule('report_established_age_days', 7))
                   OR (SELECT count(DISTINCT so.order_group_id) FROM core.seller_order so
                        WHERE so.buyer_user_id = v_actor AND so.status = 'COMPLETED')
                      >= core.report_rule('report_established_min_purchases', 1);
  v_standing := core.report_in_standing(v_actor);

  LOOP
    v_reference := core.report_reference();
    BEGIN
      INSERT INTO core.report (id, reference, case_id, reporter_user_id, reason, detail, detail_flags,
                               reporter_aged, reporter_established, reporter_in_standing)
      VALUES (v_id, v_reference, v_case.id, v_actor, p_reason, v_detail, v_flags,
              COALESCE(v_aged, false), COALESCE(v_established, false), COALESCE(v_standing, false))
      RETURNING created_at INTO v_created;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_tries := v_tries + 1;
      IF v_tries >= 5 THEN RAISE; END IF;
    END;
  END LOOP;

  -- the safety net, in this same transaction, unless the product was recently cleared (b)
  IF p_target_type = 'PRODUCT' AND NOT core.report_hide_exempt(v_product.id)
     AND core.report_qualifying_count(v_case.id) >= core.config_int(v_cfg, ARRAY['report_hide_threshold'], 3) THEN
    -- (d) one automatic hide per reporter per cooldown, across products: serialise on each
    -- qualifying reporter (ascending id), then count again with what has committed since
    FOR v_r IN SELECT q FROM core.report_qualifying_reporters(v_case.id) q ORDER BY q LOOP
      PERFORM core.lock_actor('core.report_hide', v_r);
    END LOOP;
    SELECT array_agg(q ORDER BY q) INTO v_qual FROM core.report_qualifying_reporters(v_case.id) q;
    v_n := COALESCE(cardinality(v_qual), 0);
    IF v_n >= core.config_int(v_cfg, ARRAY['report_hide_threshold'], 3) THEN
      UPDATE core.product p SET status = 'HIDDEN', moderation_reason = 'Hidden pending review',
                                updated_at = clock_timestamp()
       WHERE p.id = v_product.id;
      SELECT h.id INTO v_hide FROM core.listing_hide h WHERE h.product_id = v_product.id AND h.lifted_at IS NULL;
      UPDATE core.report_case rc SET auto_hide_id = v_hide WHERE rc.id = v_case.id;
      INSERT INTO core.report_case_hide (case_id, hide_id) VALUES (v_case.id, v_hide);
      INSERT INTO core.auto_hide_contribution (hide_id, reporter_user_id) SELECT v_hide, q FROM unnest(v_qual) q;
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

-- ---------------------------------------------------------------- Super Admin: report cases
-- As 0039, except: an UPHELD case records the hide it caused (core.report_case_hide), and a
-- DISMISSED case restores the product it hid automatically even while publication is off.
CREATE OR REPLACE FUNCTION core.admin_report_resolve(p_case uuid, p_outcome text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor   uuid := core.admin_actor();
  v_reason  text := core.admin_reason(p_reason);
  v_case    core.report_case;
  v_p       core.product;
  v_effect  text := 'NONE';
  v_hide    uuid;
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
    SELECT h.id INTO v_hide FROM core.listing_hide h WHERE h.product_id = v_p.id AND h.lifted_at IS NULL;
    IF v_hide IS NOT NULL THEN
      INSERT INTO core.report_case_hide (case_id, hide_id) VALUES (v_case.id, v_hide) ON CONFLICT (case_id) DO NOTHING;
    END IF;
  ELSIF v_case.product_id IS NOT NULL AND p_outcome = 'DISMISSED' AND v_p.status = 'HIDDEN'
        AND v_case.auto_hide_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM core.listing_hide h WHERE h.id = v_case.auto_hide_id AND h.lifted_at IS NULL) THEN
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
-- As 0039, except: an upheld appeal of a hide restores the listing even while publication is off,
-- and clears every case behind that hide (its reporters may not report the product again for a
-- while, and the product is exempt from automatic hiding for a while).
CREATE OR REPLACE FUNCTION core.admin_appeal_resolve(p_appeal uuid, p_outcome text, p_reason text) RETURNS jsonb
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
      -- back on sale as it was: the status only; stock, counters and orders are untouched
      UPDATE core.product p SET status = 'PUBLISHED', moderation_reason = NULL, updated_at = clock_timestamp()
       WHERE p.id = v_p.id;
      -- the cases behind this hide are cleared, whatever their status
      INSERT INTO core.report_clearance (case_id, product_id, cause)
      SELECT rc.id, rc.product_id, 'APPEAL_UPHELD' FROM core.report_case rc
       WHERE rc.product_id = v_p.id
         AND (rc.auto_hide_id = v_a.hide_id
              OR rc.id IN (SELECT ch.case_id FROM core.report_case_hide ch WHERE ch.hide_id = v_a.hide_id))
      ON CONFLICT (case_id) DO NOTHING;
      -- the reports that led here are answered by this decision (dismissed: cleared by the trigger)
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

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.record_case_clearance(), core.report_rule(text, bigint), core.report_in_standing(uuid),
  core.report_hide_spent(uuid), core.report_hide_exempt(uuid), core.report_qualifying_reporters(uuid)
FROM PUBLIC;
