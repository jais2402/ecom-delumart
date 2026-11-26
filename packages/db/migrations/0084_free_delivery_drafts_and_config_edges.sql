-- Sale price, review round 2 (PRD R6.2, R6.5, US-43). Replaces parts of 0036, 0081 and 0083; never edits them.
--
-- M1. The draft path cannot bypass the free-delivery floor (0083). core.draft_create, core.draft_update
--     and core.product_submit refuse FREE_DELIVERY_UNFUNDED, naming the computed minimum price, whenever
--     the resulting free-Standard-delivery flag is true and the price could not fund the fee
--     (core.free_delivery_check). Backstops, for what the config can change after a submission:
--       * core.listing_approve (screening OK or a Super Admin approval): a submission whose listing
--         would go live free-delivery-on at a price that cannot fund it is REJECTED instead
--         (decision_reason names the minimum; field freeStandardDelivery, code UNFUNDED), so the owner
--         sees "not approved" with the reason; a rejected revision leaves the live listing untouched.
--       * core.listing_publish (also reached from core.product_allocate_and_publish): refuses with
--         FREE_DELIVERY_UNFUNDED, so a listing never goes live unbuyable.
-- M2. One price minimum for both sides: the free-delivery floor reads the configured
--     `price_min_paise` (as the listing price rules do); minPriceForFreeDelivery() takes it as a
--     parameter with the seed as its default. The reference and allowance configuration is clamped
--     before any integer cast so a huge or zero value cannot error a public read: lookback days
--     1..365, minimum hours 1..(lookback days x 24), price change window hours 1..8760.
-- M3. Ending a sale is never blocked by the daily price-change allowance, but its history row COUNTS
--     toward it (0083 did not count it): at most `cap` starts, changes and list price changes are
--     allowed, plus the ends that follow, so start/end cycles cannot run unbounded.

-- ---------------------------------------------------------------- clamped configuration
CREATE FUNCTION core.reference_lookback_days() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT LEAST(GREATEST(core.config_int(core.current_config_id(), ARRAY['reference_price_lookback_days'], 30), 1), 365)::int
$$;

CREATE FUNCTION core.reference_min_hours() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT LEAST(GREATEST(core.config_int(core.current_config_id(), ARRAY['reference_price_min_hours'], 24), 1),
               core.reference_lookback_days() * 24)::int
$$;

CREATE FUNCTION core.price_change_window_hours() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT LEAST(GREATEST(core.config_int(core.current_config_id(), ARRAY['price_change_window_hours'], 24), 1), 8760)::int
$$;

CREATE OR REPLACE FUNCTION core.published_low(p_product uuid, p_end timestamptz, OUT low bigint, OUT secs numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_start timestamptz := p_end - make_interval(hours => core.reference_lookback_days() * 24);
BEGIN
  SELECT min(x.price_paise), COALESCE(sum(x.pub), 0)
    INTO low, secs
    FROM (
      SELECT r.price_paise,
             extract(epoch FROM (r.b - r.a)) - COALESCE((
               SELECT sum(extract(epoch FROM (LEAST(COALESCE(h.lifted_at, p_end), r.b) - GREATEST(h.hidden_at, r.a))))
                 FROM core.listing_hide h
                WHERE h.product_id = p_product
                  AND GREATEST(h.hidden_at, r.a) < LEAST(COALESCE(h.lifted_at, p_end), r.b)), 0) AS pub
        FROM (SELECT n.price_paise, GREATEST(n.changed_at, v_start) AS a, LEAST(n.next_at, p_end) AS b
                FROM (SELECT h.price_paise, h.changed_at,
                             lead(h.changed_at, 1, p_end) OVER (ORDER BY h.id) AS next_at
                        FROM core.price_history h WHERE h.product_id = p_product) n
               WHERE n.changed_at < p_end) r
       WHERE r.b > r.a) x
   WHERE x.pub > 0;
END $$;

CREATE OR REPLACE FUNCTION core.reference_price(p_product uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hours int := core.reference_min_hours();
  v_cur   bigint;
  v_start timestamptz;
  v_low   bigint;
  v_secs  numeric;
  r       record;
BEGIN
  FOR r IN SELECT h.price_paise, h.changed_at FROM core.price_history h WHERE h.product_id = p_product
            ORDER BY h.id DESC LOOP
    IF v_cur IS NULL THEN
      v_cur := r.price_paise;
      v_start := r.changed_at;
    ELSIF r.price_paise = v_cur THEN
      v_start := r.changed_at;
    ELSE
      EXIT;
    END IF;
  END LOOP;
  IF v_cur IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
                  WHERE p.id = p_product AND v.price_paise = v_cur) THEN
    RETURN NULL;
  END IF;
  SELECT l.low, l.secs INTO v_low, v_secs FROM core.published_low(p_product, v_start) l;
  IF v_low IS NULL OR v_low <= v_cur OR v_secs < v_hours::numeric * 3600 THEN
    RETURN NULL;
  END IF;
  RETURN v_low;
END $$;

CREATE OR REPLACE FUNCTION core.reference_ceiling(p_product uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hours int := core.reference_min_hours();
  v_low   bigint;
  v_secs  numeric;
BEGIN
  SELECT l.low, l.secs INTO v_low, v_secs FROM core.published_low(p_product, clock_timestamp()) l;
  IF v_low IS NULL OR v_secs < v_hours::numeric * 3600 THEN
    RETURN NULL;
  END IF;
  RETURN v_low;
END $$;

-- ---------------------------------------------------------------- the allowance counts ends
CREATE OR REPLACE FUNCTION core.price_change_check(p_product uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_max    bigint := core.config_int(core.current_config_id(), ARRAY['price_changes_per_product_per_day'], 20);
  v_window int := core.price_change_window_hours();
BEGIN
  IF (SELECT count(*) FROM core.price_history h
       WHERE h.product_id = p_product AND h.reason IN ('PRICE_CHANGE', 'SALE_START', 'SALE_CHANGE', 'SALE_END')
         AND h.changed_at > clock_timestamp() - make_interval(hours => v_window)) >= v_max THEN
    PERFORM core.fail('RATE_LIMITED', 'this listing''s price changed too often today; try again later');
  END IF;
END $$;

-- ---------------------------------------------------------------- the free-delivery floor
CREATE OR REPLACE FUNCTION core.min_free_delivery_price(p_cfg int) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_fee bigint := core.config_int(p_cfg, ARRAY['fee_percent'], 5);
  v_s   bigint := core.delivery_fee_paise(p_cfg, 'STANDARD', false);
  v_min bigint := core.config_paise(p_cfg, ARRAY['price_min_paise'], 10000);
  v_raw bigint;
BEGIN
  IF v_s = 0 THEN RETURN v_min; END IF;
  IF v_fee >= 100 THEN RETURN NULL; END IF;
  v_raw := (100 * (v_s - 1)) / (100 - v_fee) + 1;
  v_raw := ((v_raw + 99) / 100) * 100;
  RETURN GREATEST(v_raw, v_min);
END $$;

-- NULL when `p_price` can fund free Standard delivery, otherwise the owner-facing message.
CREATE FUNCTION core.free_delivery_problem(p_price bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_min bigint := core.min_free_delivery_price(core.current_config_id());
BEGIN
  IF v_min IS NULL THEN
    RETURN 'free Standard delivery cannot be funded from any price';
  ELSIF COALESCE(p_price, 0) < v_min THEN
    RETURN format('free Standard delivery needs a price of at least ₹%s: the delivery fee comes out of your proceeds',
                  v_min / 100);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION core.free_delivery_check(p_price bigint) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_problem text := core.free_delivery_problem(p_price);
BEGIN
  IF v_problem IS NOT NULL THEN
    PERFORM core.fail('FREE_DELIVERY_UNFUNDED', v_problem);
  END IF;
END $$;

-- ---------------------------------------------------------------- the draft path (0036, with the check)
CREATE OR REPLACE FUNCTION core.draft_create(p_name text, p_hook text, p_description text, p_category text,
                                             p_template_id int, p_alt_text text, p_price_paise bigint, p_mode text,
                                             p_quantity int, p_offers_express boolean,
                                             p_free_standard_delivery boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_name    text := btrim(p_name);
  v_hook    text := NULLIF(btrim(COALESCE(p_hook, '')), '');
  v_desc    text := btrim(p_description);
  v_alt     text := btrim(COALESCE(p_alt_text, ''));
  v_problem text[];
  v_id      uuid := core.uuid_v7();
  v_version uuid;
BEGIN
  v_problem := COALESCE(core.listing_text_problem(v_name, v_hook, v_desc, v_alt, p_template_id),
                        core.listing_price_problem(p_price_paise), core.listing_quantity_problem(p_quantity));
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('STANDARD_STOCKED', 'EXCLUSIVE') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'inventory mode is STANDARD_STOCKED or EXCLUSIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.category cat WHERE cat.slug = p_category) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown category');
  END IF;
  IF COALESCE(p_free_standard_delivery, false) THEN
    PERFORM core.free_delivery_check(p_price_paise);
  END IF;
  PERFORM 1 FROM core.company c WHERE c.id = v_company.id FOR NO KEY UPDATE;
  IF core.listing_private_count(v_company.id) >= core.listing_cap('listing_drafts_max', 20) THEN
    PERFORM core.fail('DRAFT_LIMIT', 'your studio already holds the most private drafts it may');
  END IF;
  INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode, exclusive_supply,
                            planned_quantity, offers_express, free_standard_delivery, created_at)
  VALUES (v_id, v_company.id, 'USER', 'DRAFT', p_category, p_mode,
          CASE WHEN p_mode = 'EXCLUSIVE' THEN p_quantity END,
          CASE WHEN p_mode = 'STANDARD_STOCKED' THEN p_quantity END,
          COALESCE(p_offers_express, false), COALESCE(p_free_standard_delivery, false), clock_timestamp());
  v_version := core.listing_new_version(v_id, v_name, v_hook, v_desc, v_alt, p_template_id, p_price_paise,
                                        v_company.owner_user_id);
  UPDATE core.product p SET current_version_id = v_version WHERE p.id = v_id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_id);
END $$;

CREATE OR REPLACE FUNCTION core.draft_update(p_product uuid, p_name text, p_hook text, p_description text,
                                             p_category text, p_template_id int, p_alt_text text,
                                             p_price_paise bigint, p_mode text, p_quantity int,
                                             p_offers_express boolean, p_free_standard_delivery boolean)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_cur     core.product_version;
  v_name    text;
  v_hook    text;
  v_desc    text;
  v_alt     text;
  v_tpl     int;
  v_price   bigint;
  v_cat     text;
  v_mode    text;
  v_qty     int;
  v_problem text[];
  v_version uuid;
BEGIN
  IF v_p.published_at IS NOT NULL OR v_p.status NOT IN ('DRAFT', 'REJECTED', 'NEEDS_REVIEW') THEN
    PERFORM core.fail('NOT_EDITABLE', 'only an unpublished draft is edited here (revise a live listing instead)');
  END IF;
  SELECT * INTO v_cur FROM core.product_version v WHERE v.id = v_p.current_version_id;
  v_name := COALESCE(btrim(p_name), v_cur.name);
  v_hook := CASE WHEN p_hook IS NULL THEN v_cur.hook ELSE NULLIF(btrim(p_hook), '') END;
  v_desc := COALESCE(btrim(p_description), v_cur.description);
  v_alt  := COALESCE(btrim(p_alt_text), v_cur.alt_text);
  v_tpl  := COALESCE(p_template_id, v_cur.template_id);
  v_price := COALESCE(p_price_paise, v_cur.price_paise);
  v_cat  := COALESCE(p_category, v_p.category);
  v_mode := COALESCE(p_mode, v_p.inventory_mode);
  v_qty  := COALESCE(p_quantity, CASE WHEN v_mode = 'EXCLUSIVE' THEN v_p.exclusive_supply ELSE v_p.planned_quantity END,
                     v_p.exclusive_supply, v_p.planned_quantity);
  v_problem := COALESCE(core.listing_text_problem(v_name, v_hook, v_desc, v_alt, v_tpl),
                        core.listing_price_problem(v_price), core.listing_quantity_problem(v_qty));
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF v_mode NOT IN ('STANDARD_STOCKED', 'EXCLUSIVE') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'inventory mode is STANDARD_STOCKED or EXCLUSIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.category cat WHERE cat.slug = v_cat) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown category');
  END IF;
  IF COALESCE(p_free_standard_delivery, v_p.free_standard_delivery) THEN
    PERFORM core.free_delivery_check(v_price);
  END IF;
  UPDATE core.listing_submission s SET state = 'WITHDRAWN', decided_by = 'OWNER', decided_at = clock_timestamp()
   WHERE s.product_id = v_p.id AND s.state IN ('SCREENING', 'NEEDS_REVIEW');
  v_version := core.listing_new_version(v_p.id, v_name, v_hook, v_desc, v_alt, v_tpl, v_price, v_company.owner_user_id);
  UPDATE core.product p
     SET status = 'DRAFT', current_version_id = v_version, pending_version_id = NULL, approved_needs_stock = false,
         category = v_cat, inventory_mode = v_mode,
         exclusive_supply = CASE WHEN v_mode = 'EXCLUSIVE' THEN v_qty END,
         planned_quantity = CASE WHEN v_mode = 'STANDARD_STOCKED' THEN v_qty END,
         offers_express = COALESCE(p_offers_express, p.offers_express),
         free_standard_delivery = COALESCE(p_free_standard_delivery, p.free_standard_delivery),
         updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

CREATE OR REPLACE FUNCTION core.product_submit(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
BEGIN
  IF v_p.published_at IS NOT NULL OR v_p.status <> 'DRAFT' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a draft is submitted (revise a live listing instead)');
  END IF;
  IF v_p.approved_needs_stock THEN
    PERFORM core.fail('CONFLICT', 'this listing is approved: allocate its stock to publish it');
  END IF;
  IF v_p.free_standard_delivery THEN
    PERFORM core.free_delivery_check(
      (SELECT v.price_paise FROM core.product_version v WHERE v.id = v_p.current_version_id));
  END IF;
  IF core.listing_live_count(v_company.id) + core.listing_incoming_count(v_company.id, v_p.id)
     >= core.listing_cap('listing_published_max', 10) THEN
    PERFORM core.fail('PUBLISH_LIMIT', 'your store has as many published listings as it may; archive one first');
  END IF;
  PERFORM core.listing_open_submission(v_p.id, v_p.current_version_id, v_company.id, 'FIRST');
  UPDATE core.product p
     SET status = 'SCREENING', pending_version_id = v_p.current_version_id, moderation_reason = NULL,
         updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- ---------------------------------------------------------------- the backstops
CREATE OR REPLACE FUNCTION core.listing_publish(p_product uuid, p_version uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_p   core.product;
  v_wh  core.warehouse;
  v_qty int;
  v_ver core.product_version;
BEGIN
  SELECT * INTO v_p FROM core.product p WHERE p.id = p_product;
  SELECT * INTO v_ver FROM core.product_version v WHERE v.id = p_version AND v.product_id = p_product;
  IF v_ver.id IS NULL OR v_p.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'listing_publish: not an unpublished product''s own version' USING ERRCODE = 'internal_error';
  END IF;
  IF v_p.free_standard_delivery THEN
    PERFORM core.free_delivery_check(v_ver.price_paise);     -- never go live unbuyable
  END IF;
  SELECT * INTO v_wh FROM core.warehouse w WHERE w.company_id = v_p.company_id AND w.kind = 'STARTER';
  v_qty := CASE WHEN v_p.inventory_mode = 'EXCLUSIVE' THEN v_p.exclusive_supply ELSE v_p.planned_quantity END;
  IF v_wh.id IS NULL OR v_qty IS NULL OR v_wh.capacity - v_wh.used < v_qty
     OR core.listing_live_count(v_p.company_id) >= core.listing_cap('listing_published_max', 10) THEN
    UPDATE core.product p
       SET status = 'DRAFT', approved_needs_stock = true, current_version_id = p_version,
           pending_version_id = p_version, updated_at = clock_timestamp()
     WHERE p.id = v_p.id;
    RETURN 'NEEDS_STOCK';
  END IF;
  INSERT INTO core.inventory_unit (id, product_id, warehouse_id, serial, state)
  SELECT core.uuid_v7(), v_p.id, v_wh.id, CASE WHEN v_p.inventory_mode = 'EXCLUSIVE' THEN g END, 'AVAILABLE'
    FROM generate_series(1, v_qty) g;
  UPDATE core.warehouse w SET used = w.used + v_qty WHERE w.id = v_wh.id;
  IF v_p.inventory_mode = 'EXCLUSIVE' THEN
    INSERT INTO core.exclusive_edition (product_id, supply) VALUES (v_p.id, v_qty);
  END IF;
  UPDATE core.product p
     SET status = 'PUBLISHED', published_at = clock_timestamp(), current_version_id = p_version,
         pending_version_id = NULL, approved_needs_stock = false, available_units = p.available_units + v_qty,
         moderation_reason = NULL, updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  INSERT INTO core.price_history (product_id, version_id, price_paise, previous_paise, reason)
  VALUES (v_p.id, p_version, v_ver.price_paise, NULL, 'PUBLISHED');
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_published', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', p_version, 'companyId', v_p.company_id, 'inventoryMode', v_p.inventory_mode,
    'units', v_qty, 'pricePaise', v_ver.price_paise::text), 1);
  RETURN 'PUBLISHED';
END $$;

CREATE OR REPLACE FUNCTION core.listing_approve(p_submission uuid, p_by text, p_reason text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_s       core.listing_submission;
  v_p       core.product;
  v_pinned  core.product_version;
  v_live    core.product_version;
  v_target  uuid;
  v_outcome text;
  v_problem text;
BEGIN
  SELECT * INTO v_s FROM core.listing_submission s WHERE s.id = p_submission;
  SELECT * INTO v_p FROM core.product p WHERE p.id = v_s.product_id;
  SELECT * INTO v_pinned FROM core.product_version v WHERE v.id = v_s.version_id;
  SELECT * INTO v_live FROM core.product_version v WHERE v.id = v_p.current_version_id;
  -- backstop: a listing that would go live free-delivery-on at a price that cannot fund the fee
  -- (the configuration moved after it was submitted) is not approved: the submission is rejected
  -- with the reason, a rejected revision leaves the live listing as it is
  IF v_p.free_standard_delivery THEN
    v_problem := core.free_delivery_problem(CASE WHEN v_s.kind = 'FIRST' THEN v_pinned.price_paise
                                                 ELSE v_live.price_paise END);
    IF v_problem IS NOT NULL THEN
      PERFORM core.listing_reject(v_s.id,
        jsonb_build_array(jsonb_build_object('field', 'freeStandardDelivery', 'code', 'UNFUNDED')),
        p_by, left(v_problem, 500));
      RETURN 'REJECTED';
    END IF;
  END IF;
  UPDATE core.listing_submission s
     SET state = 'APPROVED', decided_by = p_by, decision_reason = p_reason, decided_at = clock_timestamp()
   WHERE s.id = v_s.id;
  IF v_s.kind = 'FIRST' THEN
    RETURN core.listing_publish(v_s.product_id, v_s.version_id);
  END IF;
  v_target := v_pinned.id;
  IF v_pinned.price_paise <> v_live.price_paise THEN
    -- the price changed while the revision waited: the approved text goes live at the live price
    v_target := core.listing_new_version(v_p.id, v_pinned.name, v_pinned.hook, v_pinned.description,
                                         v_pinned.alt_text, v_pinned.template_id, v_live.price_paise,
                                         v_pinned.author_user_id);
  END IF;
  UPDATE core.product p SET current_version_id = v_target, pending_version_id = NULL, updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_revised', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', v_target, 'companyId', v_p.company_id), 1);
  v_outcome := 'REVISED';
  RETURN v_outcome;
END $$;

-- ---------------------------------------------------------------- the owner's read
CREATE OR REPLACE FUNCTION core.listing_json(p core.product) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.listing_json_base(p) || jsonb_build_object('sale', (
    SELECT jsonb_build_object(
             'active', s.id IS NOT NULL,
             'listPaise', s.list_paise::text,
             'salePaise', s.sale_paise::text,
             'startedAt', s.started_at,
             'referencePaise', core.reference_price(p.id)::text,
             'referenceCeilingPaise', ce.v::text,
             'canShowReference', ce.v IS NOT NULL AND ce.v > r.pmin,
             'rules', jsonb_build_object(
               'referenceMinHours', r.hours,
               'referenceLookbackDays', r.days,
               'priceChangesPerDay', r.cap,
               'priceChangeWindowHours', r.win,
               'changesRemaining', GREATEST(r.cap - (
                  SELECT count(*) FROM core.price_history h
                   WHERE h.product_id = p.id AND h.reason IN ('PRICE_CHANGE', 'SALE_START', 'SALE_CHANGE', 'SALE_END')
                     AND h.changed_at > clock_timestamp() - make_interval(hours => r.win)), 0),
               'priceMinPaise', r.pmin::text,
               'priceMaxPaise', r.pmax::text,
               'freeDeliveryMinPaise', core.min_free_delivery_price(r.cfg)::text))
      FROM (SELECT core.current_config_id() AS cfg) c
      CROSS JOIN LATERAL (SELECT c.cfg AS cfg,
             core.reference_min_hours() AS hours,
             core.reference_lookback_days() AS days,
             core.config_int(c.cfg, ARRAY['price_changes_per_product_per_day'], 20) AS cap,
             core.price_change_window_hours() AS win,
             core.config_paise(c.cfg, ARRAY['price_min_paise'], 10000) AS pmin,
             core.config_paise(c.cfg, ARRAY['price_max_paise'], 100000000000) AS pmax) r
      CROSS JOIN LATERAL (SELECT core.reference_ceiling(p.id) AS v) ce
      LEFT JOIN core.product_sale s ON s.product_id = p.id AND s.ended_at IS NULL))
$$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.reference_lookback_days(), core.reference_min_hours(), core.price_change_window_hours(),
  core.free_delivery_problem(bigint) FROM PUBLIC;
