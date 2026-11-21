-- Seventh security review, major 2 (the automatic-hide exemption) and minor 6 (the "established"
-- bar for reporters). As 0044 otherwise.
--
-- Major 2. One dismissed junk report gave a listing 30 days of immunity from the automatic hide,
-- kept across revisions. A clearance (core.report_clearance) now records, at the moment it is
-- written (BEFORE INSERT trigger, any writer; the row never changes afterwards):
--   * version_id: the product's current_version_id, i.e. the revision the decision reviewed;
--   * exempts:    whether it grants the automatic-hide exemption: an upheld appeal (APPEAL_UPHELD),
--                 or a dismissed case that had at least `report_hide_threshold` (3) QUALIFYING
--                 reports (stored at report time: aged, established, in standing, not a party of
--                 the store) or that had hidden the listing automatically.
-- core.report_hide_exempt(product) holds only while such a clearance of the product's CURRENT
-- version is younger than `report_auto_hide_exempt_days` (30): any later approved revision voids
-- it. Every clearance still blocks its reporters from reporting the product again for
-- `report_rereport_block_days` (90), and still counts against their standing, as before.
-- Clearances written before this migration exempt only when they would have under these rules and
-- the product's current version already existed when they were written.
--
-- Minor 6. A completed purchase counts towards "established" (core.report_established_purchases)
-- only when, at the time of the report:
--   * its order is at least `report_established_order_min_age_days` (3) days old;
--   * the seller is the platform (DeluluMart Originals, no company), or a company that is not the
--     reported store, not one of the reporter's (the reporter is no party of it), not owned by a
--     party of the reported store, and at least `report_established_seller_min_age_days` (7) days
--     old.
-- The result is stored on the report row as before (never re-evaluated).

-- ---------------------------------------------------------------- major 2: clearances
ALTER TABLE core.report_clearance
  ADD COLUMN version_id uuid REFERENCES core.product_version (id),
  ADD COLUMN exempts    boolean NOT NULL DEFAULT false;

-- Distinct qualifying reporters of a case, as stored on the reports at report time.
CREATE FUNCTION core.report_case_qualifying_stored(p_case uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(DISTINCT r.reporter_user_id)::int
    FROM core.report r JOIN core.report_case rc ON rc.id = r.case_id
   WHERE r.case_id = p_case AND r.reporter_aged AND r.reporter_established AND r.reporter_in_standing
     AND NOT (r.reporter_user_id = ANY (core.company_party_ids(rc.company_id)))
$$;

-- Whether a clearance of this case (for this cause) grants the automatic-hide exemption.
CREATE FUNCTION core.report_clearance_exempts(p_case uuid, p_cause text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_cause = 'APPEAL_UPHELD'
      OR EXISTS (SELECT 1 FROM core.report_case rc WHERE rc.id = p_case AND rc.auto_hide_id IS NOT NULL)
      OR core.report_case_qualifying_stored(p_case)
           >= core.config_int(core.current_config_id(), ARRAY['report_hide_threshold'], 3)
$$;

CREATE FUNCTION core.report_clearance_facts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.version_id := (SELECT p.current_version_id FROM core.product p WHERE p.id = NEW.product_id);
  NEW.exempts := NEW.product_id IS NOT NULL AND NEW.version_id IS NOT NULL
                 AND core.report_clearance_exempts(NEW.case_id, NEW.cause);
  RETURN NEW;
END $$;
CREATE TRIGGER clearance_facts BEFORE INSERT ON core.report_clearance
  FOR EACH ROW EXECUTE FUNCTION core.report_clearance_facts();

-- the clearances already written (history is otherwise never changed)
ALTER TABLE core.report_clearance DISABLE TRIGGER no_update;
UPDATE core.report_clearance cl
   SET version_id = p.current_version_id,
       exempts = core.report_clearance_exempts(cl.case_id, cl.cause)
  FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
 WHERE p.id = cl.product_id AND v.created_at <= cl.cleared_at;
ALTER TABLE core.report_clearance ENABLE TRIGGER no_update;

CREATE OR REPLACE FUNCTION core.report_hide_exempt(p_product uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.report_clearance cl JOIN core.product p ON p.id = cl.product_id
                  WHERE cl.product_id = p_product AND cl.exempts
                    AND cl.version_id = p.current_version_id
                    AND cl.cleared_at > clock_timestamp()
                          - make_interval(days => core.report_rule('report_auto_hide_exempt_days', 30)))
$$;

-- ---------------------------------------------------------------- minor 6: established purchases
-- Completed purchases of p_user that count towards "established" when reporting p_company's store
-- or listing (see the header).
CREATE FUNCTION core.report_established_purchases(p_user uuid, p_company uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(DISTINCT so.order_group_id)::int
    FROM core.seller_order so
    JOIN core.order_group g ON g.id = so.order_group_id
    LEFT JOIN core.company sc ON sc.id = so.company_id
   WHERE so.buyer_user_id = p_user AND so.status = 'COMPLETED'
     AND g.created_at <= clock_timestamp()
           - make_interval(days => core.report_rule('report_established_order_min_age_days', 3))
     AND (so.company_id IS NULL
          OR (so.company_id IS DISTINCT FROM p_company
              AND NOT (p_user = ANY (core.company_party_ids(so.company_id)))
              AND NOT (sc.owner_user_id = ANY (core.company_party_ids(p_company)))
              AND sc.created_at <= clock_timestamp()
                    - make_interval(days => core.report_rule('report_established_seller_min_age_days', 7))))
$$;

-- ---------------------------------------------------------------- reporting (as 0044, minor 6 above)
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
                   OR core.report_established_purchases(v_actor, v_company)
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

REVOKE ALL ON FUNCTION core.report_case_qualifying_stored(uuid), core.report_clearance_exempts(uuid, text),
  core.report_clearance_facts(), core.report_hide_exempt(uuid), core.report_established_purchases(uuid, uuid)
FROM PUBLIC;
