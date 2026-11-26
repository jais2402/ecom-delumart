-- Sale price, review round 1 (PRD R6.2, R6.5, US-43). Replaces parts of 0043 and 0081; never edits them.
--
-- 1. The reference ("was") price is the LOWEST price the product was published at (a list price or
--    a sale price, any version) in the `reference_price_lookback_days` (30) before the current
--    price took effect, shown only when it is strictly above the current price and the product was
--    published for at least `reference_price_min_hours` (24) within that window. A product
--    published for less than the window uses its whole history. A hidden period counts as no
--    price: it neither sets the minimum nor breaks the minimum hours. (Raising a price first and
--    cutting it later, or raising a sale price and dropping it back, therefore shows nothing above
--    the 30-day low.) The same rule as referencePrice() in packages/core/src/pricing/reference-price.ts;
--    a database property test holds the two together.
--      core.published_low(product, end)  lowest published price and published seconds in the
--                                        window before `end` (the runs of core.price_history, minus
--                                        the hides of core.listing_hide)
--      core.reference_price(product)     replaces 0043's
--      core.reference_ceiling(product)   what a price set now would be compared with (replaces
--                                        0081's reference_price_possible, dropped)
-- 2. A sale price or the free-delivery toggle can no longer make a listing unbuyable: when the
--    resulting live price could not fund the Standard fee out of the seller's proceeds under the
--    pricing function (price - floor(price * fee% / 100) >= the Standard fee), the command is
--    refused with FREE_DELIVERY_UNFUNDED, naming the minimum price (core.min_free_delivery_price,
--    from configuration; minPriceForFreeDelivery() in core is the same arithmetic). Covers
--    core.product_set_sale_price, core.product_set_price (with free delivery on) and
--    core.product_set_shipping (turning free delivery on).
-- 3. Ending a sale is never blocked by, and never counts against, the daily price-change allowance
--    (it still writes its history row): fixing a mistake must always be possible.
-- 4. The owner's view (core.listing_json -> core.my_product, core.my_products) carries `sale.rules`:
--    the effective reference minimum hours and lookback days, the daily allowance and window, the
--    changes left today, the price bounds and the minimum price for free delivery, so the studio
--    reads configuration rather than constants; and `sale.referenceCeilingPaise`.
-- 5. The configuration keys this feature reads are written into the existing configuration
--    versions with the defaults the functions used as fallbacks (a key already present wins), so
--    they are visible configuration. No new configuration version is created, and no behaviour
--    changes by it.

UPDATE core.config_version
   SET values = jsonb_build_object(
         'price_changes_per_product_per_day', 20,
         'price_change_window_hours', 24,
         'reference_price_min_hours', 24,
         'reference_price_lookback_days', 30) || values;

-- ---------------------------------------------------------------- the lowest published price
CREATE FUNCTION core.published_low(p_product uuid, p_end timestamptz, OUT low bigint, OUT secs numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_start timestamptz := p_end - make_interval(
    hours => core.config_int(core.current_config_id(), ARRAY['reference_price_lookback_days'], 30)::int * 24);
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
  v_hours int := core.config_int(core.current_config_id(), ARRAY['reference_price_min_hours'], 24)::int;
  v_cur   bigint;
  v_start timestamptz;
  v_low   bigint;
  v_secs  numeric;
  r       record;
BEGIN
  -- newest first: the current price's run (consecutive entries at one price are one run)
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
  -- the history's last price is the live price
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

CREATE FUNCTION core.reference_ceiling(p_product uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hours int := core.config_int(core.current_config_id(), ARRAY['reference_price_min_hours'], 24)::int;
  v_low   bigint;
  v_secs  numeric;
BEGIN
  SELECT l.low, l.secs INTO v_low, v_secs FROM core.published_low(p_product, clock_timestamp()) l;
  IF v_low IS NULL OR v_secs < v_hours::numeric * 3600 THEN
    RETURN NULL;
  END IF;
  RETURN v_low;
END $$;

-- ---------------------------------------------------------------- the floor for free delivery
-- The lowest whole-rupee price that funds the Standard fee: smallest L with L - floor(L * fee / 100) >= S.
CREATE FUNCTION core.min_free_delivery_price(p_cfg int) RETURNS bigint
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

CREATE FUNCTION core.free_delivery_check(p_price bigint) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_min bigint := core.min_free_delivery_price(core.current_config_id());
BEGIN
  IF v_min IS NULL THEN
    PERFORM core.fail('FREE_DELIVERY_UNFUNDED', 'free Standard delivery cannot be funded from any price');
  ELSIF COALESCE(p_price, 0) < v_min THEN
    PERFORM core.fail('FREE_DELIVERY_UNFUNDED', format(
      'free Standard delivery needs a price of at least ₹%s: the delivery fee comes out of your proceeds', v_min / 100));
  END IF;
END $$;

-- ---------------------------------------------------------------- the allowance: ends do not count
CREATE OR REPLACE FUNCTION core.price_change_check(p_product uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cfg    int := core.current_config_id();
  v_max    bigint := core.config_int(v_cfg, ARRAY['price_changes_per_product_per_day'], 20);
  v_window int := core.config_int(v_cfg, ARRAY['price_change_window_hours'], 24)::int;
BEGIN
  IF (SELECT count(*) FROM core.price_history h
       WHERE h.product_id = p_product AND h.reason IN ('PRICE_CHANGE', 'SALE_START', 'SALE_CHANGE')
         AND h.changed_at > clock_timestamp() - make_interval(hours => v_window)) >= v_max THEN
    PERFORM core.fail('RATE_LIMITED', 'this listing''s price changed too often today; try again later');
  END IF;
END $$;

-- ---------------------------------------------------------------- the commands
CREATE OR REPLACE FUNCTION core.product_set_sale_price(p_product uuid, p_sale_price_paise bigint,
                                                       p_require_reference boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_live    core.product_version;
  v_sale    core.product_sale;
  v_list    bigint;
  v_problem text[];
  v_version uuid;
  v_ref     bigint;
BEGIN
  IF p_sale_price_paise IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a sale price is needed');
  END IF;
  IF v_p.status <> 'PUBLISHED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a published listing goes on sale');
  END IF;
  v_problem := core.listing_price_problem(p_sale_price_paise);
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  SELECT * INTO v_live FROM core.product_version v WHERE v.id = v_p.current_version_id;
  SELECT * INTO v_sale FROM core.product_sale s WHERE s.product_id = v_p.id AND s.ended_at IS NULL;
  v_list := COALESCE(v_sale.list_paise, v_live.price_paise);
  IF p_sale_price_paise >= v_list THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a sale price is lower than the list price');
  END IF;
  IF v_sale.id IS NOT NULL AND v_live.price_paise = p_sale_price_paise THEN
    RETURN core.listing_result(v_p.id);                       -- the same sale price again
  END IF;
  IF v_p.free_standard_delivery THEN
    PERFORM core.free_delivery_check(p_sale_price_paise);
  END IF;
  PERFORM core.price_change_check(v_p.id);
  v_version := core.listing_new_version(v_p.id, v_live.name, v_live.hook, v_live.description, v_live.alt_text,
                                        v_live.template_id, p_sale_price_paise, v_company.owner_user_id);
  UPDATE core.product p SET current_version_id = v_version, updated_at = clock_timestamp() WHERE p.id = v_p.id;
  INSERT INTO core.price_history (product_id, version_id, price_paise, previous_paise, reason)
  VALUES (v_p.id, v_version, p_sale_price_paise, v_live.price_paise,
          CASE WHEN v_sale.id IS NULL THEN 'SALE_START' ELSE 'SALE_CHANGE' END);
  IF v_sale.id IS NULL THEN
    INSERT INTO core.product_sale (product_id, list_paise, sale_paise) VALUES (v_p.id, v_list, p_sale_price_paise);
  ELSE
    UPDATE core.product_sale s SET sale_paise = p_sale_price_paise WHERE s.id = v_sale.id;
  END IF;
  v_ref := core.reference_price(v_p.id);
  IF COALESCE(p_require_reference, false) AND v_ref IS NULL THEN
    PERFORM core.fail('REFERENCE_PRICE_INELIGIBLE',
                      'no earlier price qualifies to show as the "was" price (the lowest price of the last 30 days must be higher, and the listing published for 24 hours)');
  END IF;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'sale_price_set', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', v_version, 'companyId', v_company.id,
    'listPaise', v_list::text, 'salePaise', p_sale_price_paise::text, 'referencePaise', v_ref::text,
    'referenceRequested', COALESCE(p_require_reference, false)), 1);
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- Ending a sale is never refused by the allowance and does not use any of it.
CREATE OR REPLACE FUNCTION core.product_end_sale(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_live    core.product_version;
  v_sale    core.product_sale;
  v_version uuid;
BEGIN
  IF v_p.status <> 'PUBLISHED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a published listing is on sale');
  END IF;
  SELECT * INTO v_sale FROM core.product_sale s WHERE s.product_id = v_p.id AND s.ended_at IS NULL;
  IF v_sale.id IS NULL THEN
    PERFORM core.fail('NOT_EDITABLE', 'this listing is not on sale');
  END IF;
  SELECT * INTO v_live FROM core.product_version v WHERE v.id = v_p.current_version_id;
  v_version := core.listing_new_version(v_p.id, v_live.name, v_live.hook, v_live.description, v_live.alt_text,
                                        v_live.template_id, v_sale.list_paise, v_company.owner_user_id);
  UPDATE core.product p SET current_version_id = v_version, updated_at = clock_timestamp() WHERE p.id = v_p.id;
  INSERT INTO core.price_history (product_id, version_id, price_paise, previous_paise, reason)
  VALUES (v_p.id, v_version, v_sale.list_paise, v_live.price_paise, 'SALE_END');
  UPDATE core.product_sale s SET ended_at = clock_timestamp() WHERE s.id = v_sale.id;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'sale_price_ended', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', v_version, 'companyId', v_company.id,
    'listPaise', v_sale.list_paise::text, 'salePaise', v_live.price_paise::text), 1);
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

CREATE OR REPLACE FUNCTION core.product_set_price(p_product uuid, p_price_paise bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
  v_live    core.product_version;
  v_problem text[] := core.listing_price_problem(p_price_paise);
  v_version uuid;
BEGIN
  IF v_problem IS NOT NULL THEN PERFORM core.fail(v_problem[1], v_problem[2]); END IF;
  IF v_p.status <> 'PUBLISHED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'only a published listing is repriced (edit the draft instead)');
  END IF;
  IF EXISTS (SELECT 1 FROM core.product_sale s WHERE s.product_id = v_p.id AND s.ended_at IS NULL) THEN
    PERFORM core.fail('NOT_EDITABLE', 'this listing is on sale: end the sale before changing its price');
  END IF;
  SELECT * INTO v_live FROM core.product_version v WHERE v.id = v_p.current_version_id;
  IF v_live.price_paise = p_price_paise THEN
    RETURN core.listing_result(v_p.id);
  END IF;
  IF v_p.free_standard_delivery THEN
    PERFORM core.free_delivery_check(p_price_paise);
  END IF;
  PERFORM core.price_change_check(v_p.id);
  v_version := core.listing_new_version(v_p.id, v_live.name, v_live.hook, v_live.description, v_live.alt_text,
                                        v_live.template_id, p_price_paise, v_company.owner_user_id);
  UPDATE core.product p SET current_version_id = v_version, updated_at = clock_timestamp() WHERE p.id = v_p.id;
  INSERT INTO core.price_history (product_id, version_id, price_paise, previous_paise, reason)
  VALUES (v_p.id, v_version, p_price_paise, v_live.price_paise, 'PRICE_CHANGE');
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'listing_price_changed', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', v_version, 'companyId', v_company.id,
    'pricePaise', p_price_paise::text, 'previousPaise', v_live.price_paise::text), 1);
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

-- 0036's delivery options: turning free Standard delivery ON needs a price that can fund it.
CREATE OR REPLACE FUNCTION core.product_set_shipping(p_product uuid, p_offers_express boolean,
                                                     p_free_standard_delivery boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_company core.company := core.listing_studio();
  v_p       core.product := core.listing_own_locked(v_company.id, p_product);
BEGIN
  IF v_p.status = 'ARCHIVED' THEN
    PERFORM core.fail('NOT_EDITABLE', 'an archived listing does not change');
  END IF;
  IF p_free_standard_delivery IS TRUE AND NOT v_p.free_standard_delivery THEN
    PERFORM core.free_delivery_check(
      (SELECT v.price_paise FROM core.product_version v WHERE v.id = v_p.current_version_id));
  END IF;
  UPDATE core.product p
     SET offers_express = COALESCE(p_offers_express, p.offers_express),
         free_standard_delivery = COALESCE(p_free_standard_delivery, p.free_standard_delivery),
         updated_at = clock_timestamp()
   WHERE p.id = v_p.id;
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
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
                   WHERE h.product_id = p.id AND h.reason IN ('PRICE_CHANGE', 'SALE_START', 'SALE_CHANGE')
                     AND h.changed_at > clock_timestamp() - make_interval(hours => r.win::int)), 0),
               'priceMinPaise', r.pmin::text,
               'priceMaxPaise', r.pmax::text,
               'freeDeliveryMinPaise', core.min_free_delivery_price(r.cfg)::text))
      FROM (SELECT core.current_config_id() AS cfg) c
      CROSS JOIN LATERAL (SELECT c.cfg AS cfg,
             core.config_int(c.cfg, ARRAY['reference_price_min_hours'], 24) AS hours,
             core.config_int(c.cfg, ARRAY['reference_price_lookback_days'], 30) AS days,
             core.config_int(c.cfg, ARRAY['price_changes_per_product_per_day'], 20) AS cap,
             core.config_int(c.cfg, ARRAY['price_change_window_hours'], 24) AS win,
             core.config_paise(c.cfg, ARRAY['price_min_paise'], 10000) AS pmin,
             core.config_paise(c.cfg, ARRAY['price_max_paise'], 100000000000) AS pmax) r
      CROSS JOIN LATERAL (SELECT core.reference_ceiling(p.id) AS v) ce
      LEFT JOIN core.product_sale s ON s.product_id = p.id AND s.ended_at IS NULL))
$$;

DROP FUNCTION core.reference_price_possible(uuid);

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.published_low(uuid, timestamptz), core.reference_ceiling(uuid),
  core.min_free_delivery_price(int), core.free_delivery_check(bigint) FROM PUBLIC;
