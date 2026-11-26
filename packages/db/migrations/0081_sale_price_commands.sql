-- Sale price, part 2: the owner's commands and reads (PRD R6.2, R8 Pricing, R10 PUT
-- /products/:id/sale-price, REFERENCE_PRICE_INELIGIBLE, sale_price_set; US-43, US-08).
--
-- Commands (EXECUTE for app_web only; the same shape as core.product_set_price, 0036: the owner is
-- derived from the sign-in session, the actor's studio lock, then the canonical locks company #4,
-- warehouses #5, product #6 each FOR NO KEY UPDATE under a 2 s lock_timeout; another company's
-- product is NOT_FOUND exactly as one that does not exist; a worker or a stranger has no company
-- of their own here, so they are refused before anything is read):
--
--   core.product_set_sale_price(product, sale_price_paise, require_reference)
--     A PUBLISHED listing goes on sale at a price lower than its list price (the live price when
--     no sale is open, otherwise the list price the open sale started from), in whole rupees from
--     the configured minimum to the maximum price. A new version at the sale price is live at
--     once and recorded in core.price_history (SALE_START, or SALE_CHANGE when a sale is already
--     open); outstanding quotes are refused at pay (CART_CHANGED, 0018). When require_reference is
--     true and no earlier price would show as the reference ("was") price (core.reference_price,
--     0043), the whole command is refused with REFERENCE_PRICE_INELIGIBLE and nothing changes.
--     Without it the sale simply shows the current price only. The same price again is a no-op.
--   core.product_end_sale(product)
--     Restores the list price (a new version, SALE_END) and closes the sale; NOT_EDITABLE when no
--     sale is open. Ending a sale never leaves a reference price: the restored price is not lower
--     than the one before it.
--   core.product_set_price (0036, replaced)
--     Refused during a sale (NOT_EDITABLE: end the sale first), so the list price a sale returns
--     to cannot be moved under it.
--
-- Every price change of a listing (a price change, a sale, a changed sale price, an end) counts
-- against `price_changes_per_product_per_day` (20) within `price_change_window_hours` (24): beyond
-- it RATE_LIMITED. A same-price call changes nothing and counts nothing. This stops a listing's
-- price being flipped to keep quotes failing or to manufacture a reference price.
--
-- Reads: core.listing_json (and so core.my_products and core.my_product) gain `sale` for the
-- owner: {active, listPaise, salePaise, startedAt, referencePaise, canShowReference}. The
-- price history is already in core.my_product. Nothing public changes shape.

-- ---------------------------------------------------------------- helpers (not granted to anyone)
-- Whether another price change of this listing is allowed now; RATE_LIMITED otherwise.
CREATE FUNCTION core.price_change_check(p_product uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cfg    int := core.current_config_id();
  v_max    bigint := core.config_int(v_cfg, ARRAY['price_changes_per_product_per_day'], 20);
  v_window int := core.config_int(v_cfg, ARRAY['price_change_window_hours'], 24)::int;
BEGIN
  IF (SELECT count(*) FROM core.price_history h
       WHERE h.product_id = p_product AND h.reason IN ('PRICE_CHANGE', 'SALE_START', 'SALE_CHANGE', 'SALE_END')
         AND h.changed_at > clock_timestamp() - make_interval(hours => v_window)) >= v_max THEN
    PERFORM core.fail('RATE_LIMITED', 'this listing''s price changed too often today; try again later');
  END IF;
END $$;

-- Whether a lower price set now would show a reference ("was") price: the current price has been
-- the listing's published price for at least `reference_price_min_hours` (24) continuous hours and
-- the listing was not hidden meanwhile. The same rule as core.reference_price (0043) looked at from
-- the moment of the change; the tests hold the two together.
CREATE FUNCTION core.reference_price_possible(p_product uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hours int := core.config_int(core.current_config_id(), ARRAY['reference_price_min_hours'], 24)::int;
  v_cur   bigint;
  v_start timestamptz;
  v_now   timestamptz := clock_timestamp();
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
  IF v_cur IS NULL OR v_now - v_start < make_interval(hours => v_hours) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM core.listing_hide h
                      WHERE h.product_id = p_product AND h.hidden_at < v_now
                        AND (h.lifted_at IS NULL OR h.lifted_at > v_start));
END $$;

-- ---------------------------------------------------------------- commands
CREATE FUNCTION core.product_set_sale_price(p_product uuid, p_sale_price_paise bigint,
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
                      'the earlier price was not the published price for long enough to show it');
  END IF;
  INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
  VALUES (core.uuid_v7(), 'sale_price_set', v_p.id, jsonb_build_object(
    'productId', v_p.id, 'versionId', v_version, 'companyId', v_company.id,
    'listPaise', v_list::text, 'salePaise', p_sale_price_paise::text, 'referencePaise', v_ref::text,
    'referenceRequested', COALESCE(p_require_reference, false)), 1);
  PERFORM core.listing_checks();
  RETURN core.listing_result(v_p.id);
END $$;

CREATE FUNCTION core.product_end_sale(p_product uuid) RETURNS jsonb
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
  PERFORM core.price_change_check(v_p.id);
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

-- 0036's price-only change, refused during a sale and counted against the daily allowance.
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

-- ---------------------------------------------------------------- the owner's read
-- core.listing_json (0036) keeps its body under a new name; the wrapper adds the sale state.
ALTER FUNCTION core.listing_json(core.product) RENAME TO listing_json_base;
REVOKE ALL ON FUNCTION core.listing_json_base(core.product) FROM PUBLIC, app_web;

CREATE FUNCTION core.listing_json(p core.product) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.listing_json_base(p) || jsonb_build_object('sale', (
    SELECT jsonb_build_object(
             'active', s.id IS NOT NULL,
             'listPaise', s.list_paise::text,
             'salePaise', s.sale_paise::text,
             'startedAt', s.started_at,
             'referencePaise', core.reference_price(p.id)::text,
             'canShowReference', core.reference_price_possible(p.id))
      FROM (SELECT 1) x LEFT JOIN core.product_sale s ON s.product_id = p.id AND s.ended_at IS NULL))
$$;
REVOKE ALL ON FUNCTION core.listing_json(core.product) FROM PUBLIC;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.price_change_check(uuid), core.reference_price_possible(uuid),
  core.product_set_sale_price(uuid, bigint, boolean), core.product_end_sale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.product_set_sale_price(uuid, bigint, boolean), core.product_end_sale(uuid) TO app_web;
