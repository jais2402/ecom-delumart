-- Merchant read models (US-45 portal finances agree with the ledger; US-20 brand progress; LLD §1
-- "company time zone (default Asia/Kolkata) for portal reports"). Read-only, for the signed-in
-- owner of a company: every function derives the company from the sign-in session
-- (COMPANY_FEE_REQUIRED without one), and a seller order of another company is NOT_FOUND exactly as
-- one that does not exist. No buyer identity ever leaves these functions: no user id, email,
-- phone, address or name; a buyer is "Anonymous player", and buyers are only ever counted.
--
--   core.my_seller_orders(cursor, page_size), core.my_seller_order(seller_order_id)
--     Order time, lines (product name as bought, list price, seller discount, fee), delivery speed
--     and timeline, delivery fee paid by the buyer and by the seller, list, discount, gross (list
--     after seller discount), fee, net (what the owner was credited: the PURCHASE journal's
--     posting to the owner for this seller order), status, the coupon code when it was this
--     store's own, and the source (PLAYER or STAFF).
--   core.my_earnings(period_days) -> core.company_earnings(company, days, as_of)
--     The period is the last `days` (default 7, at most 90) whole days in the company's reporting
--     time zone, today included up to `as_of`; the previous period is the `days` days before it.
--     For each: completed PLAYER orders, gross (list after seller discount), marketplace fees,
--     merchant-funded delivery, net (from the ledger postings credited to the owner for those
--     seller orders), distinct buyers (a count) and the average order value (gross / orders,
--     whole paise). STAFF orders are reported separately. A daily series of the period, bucketed
--     by the local date; the top five products of the period by gross.
--   core.my_brand_progress() -> lifetime qualifying gross (buyer-paid item amounts of completed,
--     non-reversed PLAYER seller orders that qualify for progression), distinct eligible buyers
--     (accounts at least `brand_buyer_min_age_hours` (24) old, never the owner), the thresholds
--     (`brand_threshold_paise` ₹10 crore, `brand_min_buyers` 5) and whether they are met and the
--     brand tier unlocked. Nothing is granted here.
--   core.my_inventory() -> warehouses (capacity, used, free, Zap hub) and, per published product,
--     available / issued / retired units, a low-stock flag (available at or below
--     `listing_low_stock_threshold`, 5) and an exclusive edition's supply and issued count.

-- The company's reporting time zone (LLD §1: default Asia/Kolkata; companies carry no zone yet).
CREATE FUNCTION core.company_time_zone(p_company uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'Asia/Kolkata'::text
$$;

-- The signed-in owner's company id, or COMPANY_FEE_REQUIRED.
CREATE FUNCTION core.merchant_company() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company uuid;
BEGIN
  SELECT c.id INTO v_company FROM core.company c WHERE c.owner_user_id = core.require_actor();
  IF v_company IS NULL THEN
    PERFORM core.fail('COMPANY_FEE_REQUIRED', 'register a company first');
  END IF;
  RETURN v_company;
END $$;

-- What the owner was credited for a seller order: the PURCHASE journal's USER credit for it.
CREATE FUNCTION core.seller_order_credit(p_seller_order uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(SUM(p.amount), 0)::bigint
    FROM ledger.posting p
    JOIN ledger.ledger_account a ON a.id = p.account_id
    JOIN ledger.journal j ON j.id = p.journal_id
   WHERE p.seller_order_id = p_seller_order AND a.type = 'USER' AND p.amount > 0 AND j.event_type = 'PURCHASE'
$$;

-- ---------------------------------------------------------------- orders
CREATE FUNCTION core.seller_order_json(p_seller_order uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'sellerOrderId', so.id,
    'orderedAt', g.created_at,
    'status', so.status,
    'source', g.buyer_source,
    'buyer', 'Anonymous player',
    'listPaise', so.list_paise::text,
    'discountPaise', so.seller_discount_paise::text,
    'grossPaise', (so.list_paise - so.seller_discount_paise)::text,
    'feePaise', so.fee_paise::text,
    'deliveryFeeBuyerPaise', so.delivery_fee_buyer_paise::text,
    'deliveryFeeSellerPaise', so.delivery_fee_seller_paise::text,
    'netPaise', core.seller_order_credit(so.id)::text,
    'couponCode', (SELECT cp.code_normalised FROM core.coupon_redemption r JOIN core.coupon cp ON cp.id = r.coupon_id
                    WHERE r.order_group_id = so.order_group_id AND cp.company_id = so.company_id LIMIT 1),
    'delivery', (SELECT jsonb_build_object('speed', sh.speed, 'placedAt', sh.placed_at, 'packedAt', sh.packed_at,
                                           'shippedAt', sh.shipped_at, 'outAt', sh.out_at,
                                           'deliveredAt', sh.delivered_at, 'cancelledAt', sh.cancelled_at)
                   FROM core.shipment sh WHERE sh.seller_order_id = so.id),
    'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'productId', l.product_id, 'name', l.snapshot ->> 'name', 'editionSerial', l.edition_serial,
                       'listPaise', l.list_paise::text, 'discountPaise', l.seller_discount_paise::text,
                       'feePaise', l.fee_paise::text) ORDER BY l.line_no), '[]'::jsonb)
                FROM core.order_line l WHERE l.seller_order_id = so.id))
    FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
   WHERE so.id = p_seller_order
$$;

CREATE FUNCTION core.my_seller_orders(p_cursor uuid, p_page_size int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company uuid := core.merchant_company();
  v_size    int := core.page_size(p_page_size);
  v_items   jsonb;
  v_ids     uuid[];
BEGIN
  SELECT COALESCE(jsonb_agg(core.seller_order_json(x.id) ORDER BY x.id DESC), '[]'::jsonb), array_agg(x.id ORDER BY x.id DESC)
    INTO v_items, v_ids
    FROM (SELECT so.id FROM core.seller_order so
           WHERE so.company_id = v_company AND (p_cursor IS NULL OR so.id < p_cursor)
           ORDER BY so.id DESC LIMIT v_size) x;
  RETURN jsonb_build_object('items', v_items,
    'nextCursor', CASE WHEN cardinality(v_ids) = v_size THEN v_ids[v_size] END);
END $$;

CREATE FUNCTION core.my_seller_order(p_seller_order uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company uuid := core.merchant_company();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.seller_order so WHERE so.id = p_seller_order AND so.company_id = v_company) THEN
    PERFORM core.fail('NOT_FOUND', 'order not found');
  END IF;
  RETURN core.seller_order_json(p_seller_order);
END $$;

-- ---------------------------------------------------------------- earnings
-- Totals of one company's COMPLETED seller orders of one source placed in [p_from, p_to).
CREATE FUNCTION core.earnings_totals(p_company uuid, p_source text, p_from timestamptz, p_to timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH o AS (
    SELECT so.id, so.list_paise - so.seller_discount_paise AS gross, so.fee_paise, so.delivery_fee_seller_paise,
           so.buyer_user_id, core.seller_order_credit(so.id) AS net
      FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
     WHERE so.company_id = p_company AND so.status = 'COMPLETED' AND g.buyer_source = p_source
       AND g.created_at >= p_from AND g.created_at < p_to)
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to,
    'orders', count(*),
    'grossPaise', COALESCE(SUM(o.gross), 0)::text,
    'feesPaise', COALESCE(SUM(o.fee_paise), 0)::text,
    'merchantDeliveryPaise', COALESCE(SUM(o.delivery_fee_seller_paise), 0)::text,
    'netPaise', COALESCE(SUM(o.net), 0)::text,
    'distinctBuyers', count(DISTINCT o.buyer_user_id),
    'averageOrderPaise', CASE WHEN count(*) > 0 THEN div(SUM(o.gross), count(*))::text END)
    FROM o
$$;

-- The earnings report of a company for `p_days` local days ending on the local date of `p_as_of`.
-- Not granted to any application role: core.my_earnings calls it for the owner's own company at
-- the database clock (tests call it directly with a chosen as-of time).
CREATE FUNCTION core.company_earnings(p_company uuid, p_days int, p_as_of timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_days   int;
  v_tz     text := core.company_time_zone(p_company);
  v_today  date;
  v_start  date;
  v_cur    timestamptz;
  v_prev   timestamptz;
  v_daily  jsonb;
  v_top    jsonb;
BEGIN
  IF p_days IS NOT NULL AND p_days < 1 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the period is at least one day');
  END IF;
  v_days := LEAST(COALESCE(p_days, 7), core.config_int(core.current_config_id(), ARRAY['earnings_period_days_max'], 90)::int);
  v_today := (p_as_of AT TIME ZONE v_tz)::date;
  v_start := v_today - (v_days - 1);
  v_cur := v_start::timestamp AT TIME ZONE v_tz;
  v_prev := (v_start - v_days)::timestamp AT TIME ZONE v_tz;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'date', d.day, 'orders', COALESCE(x.orders, 0), 'grossPaise', COALESCE(x.gross, 0)::text,
           'netPaise', COALESCE(x.net, 0)::text) ORDER BY d.day), '[]'::jsonb)
    INTO v_daily
    FROM generate_series(v_start::timestamp, v_today::timestamp, interval '1 day') AS d0(t)
    CROSS JOIN LATERAL (SELECT d0.t::date AS day) d
    LEFT JOIN (
      SELECT (g.created_at AT TIME ZONE v_tz)::date AS day, count(*) AS orders,
             SUM(so.list_paise - so.seller_discount_paise) AS gross, SUM(core.seller_order_credit(so.id)) AS net
        FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
       WHERE so.company_id = p_company AND so.status = 'COMPLETED' AND g.buyer_source = 'PLAYER'
         AND g.created_at >= v_cur AND g.created_at < p_as_of
       GROUP BY 1) x ON x.day = d.day;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('productId', t.product_id, 'name', t.name, 'units', t.units,
                                               'grossPaise', t.gross::text) ORDER BY t.gross DESC, t.product_id), '[]'::jsonb)
    INTO v_top
    FROM (SELECT l.product_id, (array_agg(l.snapshot ->> 'name' ORDER BY g.created_at DESC))[1] AS name,
                 count(*) AS units, SUM(l.list_paise - l.seller_discount_paise) AS gross
            FROM core.order_line l
            JOIN core.seller_order so ON so.id = l.seller_order_id
            JOIN core.order_group g ON g.id = so.order_group_id
           WHERE so.company_id = p_company AND so.status = 'COMPLETED' AND g.buyer_source = 'PLAYER'
             AND g.created_at >= v_cur AND g.created_at < p_as_of
           GROUP BY l.product_id
           ORDER BY gross DESC, l.product_id LIMIT 5) t;

  RETURN jsonb_build_object(
    'periodDays', v_days, 'timeZone', v_tz, 'asOf', p_as_of,
    'current', core.earnings_totals(p_company, 'PLAYER', v_cur, p_as_of),
    'previous', core.earnings_totals(p_company, 'PLAYER', v_prev, v_cur),
    'staff', jsonb_build_object('current', core.earnings_totals(p_company, 'STAFF', v_cur, p_as_of),
                                'previous', core.earnings_totals(p_company, 'STAFF', v_prev, v_cur)),
    'daily', v_daily,
    'topProducts', v_top);
END $$;

CREATE FUNCTION core.my_earnings(p_period_days int DEFAULT 7) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.company_earnings(core.merchant_company(), p_period_days, clock_timestamp())
$$;

-- ---------------------------------------------------------------- brand progress (read only)
CREATE FUNCTION core.my_brand_progress() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company   uuid := core.merchant_company();
  v_cfg       int := core.current_config_id();
  v_threshold bigint := core.config_paise(v_cfg, ARRAY['brand_threshold_paise'], 10000000000);
  v_min       bigint := core.config_int(v_cfg, ARRAY['brand_min_buyers'], 5);
  v_age       int := core.config_int(v_cfg, ARRAY['brand_buyer_min_age_hours'], 24)::int;
  v_parties   uuid[] := core.company_party_ids(v_company);
  v_gross     bigint;
  v_buyers    bigint;
  v_tier      text;
BEGIN
  SELECT COALESCE(SUM(so.list_paise - so.seller_discount_paise - so.platform_discount_paise), 0),
         count(DISTINCT so.buyer_user_id) FILTER (
           WHERE NOT (so.buyer_user_id = ANY (v_parties))
             AND EXISTS (SELECT 1 FROM core.user_profile up
                          WHERE up.id = so.buyer_user_id
                            AND up.created_at <= clock_timestamp() - make_interval(hours => v_age)))
    INTO v_gross, v_buyers
    FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
   WHERE so.company_id = v_company AND so.status = 'COMPLETED' AND g.buyer_source = 'PLAYER'
     AND so.qualifies_for_progression AND NOT (so.buyer_user_id = ANY (v_parties));
  SELECT c.tier INTO v_tier FROM core.company c WHERE c.id = v_company;
  RETURN jsonb_build_object(
    'qualifyingGrossPaise', v_gross::text,
    'eligibleBuyers', v_buyers,
    'thresholdPaise', v_threshold::text,
    'minBuyers', v_min,
    'buyerMinAgeHours', v_age,
    'grossMet', v_gross >= v_threshold,
    'buyersMet', v_buyers >= v_min,
    'qualifies', v_gross >= v_threshold AND v_buyers >= v_min,
    'tier', v_tier,
    'brandUnlocked', v_tier = 'BRAND');
END $$;

-- ---------------------------------------------------------------- inventory
CREATE FUNCTION core.my_inventory() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH co AS (SELECT core.merchant_company() AS id),
  low AS (SELECT core.config_int(core.current_config_id(), ARRAY['listing_low_stock_threshold'], 5) AS n)
  SELECT jsonb_build_object(
    'lowStockThreshold', (SELECT n FROM low),
    'warehouses', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'id', w.id, 'kind', w.kind, 'capacity', w.capacity, 'used', w.used,
                      'free', w.capacity - w.used, 'zapHub', w.zap_hub) ORDER BY w.id), '[]'::jsonb)
                     FROM core.warehouse w WHERE w.company_id = (SELECT id FROM co)),
    'products', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'productId', p.id, 'name', v.name, 'status', p.status, 'inventoryMode', p.inventory_mode,
                    'available', st.available, 'issued', st.issued, 'retired', st.retired,
                    'lowStock', st.available <= (SELECT n FROM low),
                    'edition', (SELECT jsonb_build_object('supply', e.supply, 'issued', st.issued)
                                  FROM core.exclusive_edition e WHERE e.product_id = p.id))
                  ORDER BY p.id DESC), '[]'::jsonb)
                   FROM core.product p
                   LEFT JOIN core.product_version v ON v.id = p.current_version_id
                   CROSS JOIN LATERAL (
                     SELECT count(*) FILTER (WHERE u.state = 'AVAILABLE') AS available,
                            count(*) FILTER (WHERE u.state IN ('ISSUED', 'REVOKED_ISSUED')) AS issued,
                            count(*) FILTER (WHERE u.state = 'RETIRED_UNSOLD') AS retired
                       FROM core.inventory_unit u WHERE u.product_id = p.id) st
                  WHERE p.company_id = (SELECT id FROM co) AND p.published_at IS NOT NULL))
$$;

REVOKE ALL ON FUNCTION core.company_time_zone(uuid), core.merchant_company(), core.seller_order_credit(uuid),
  core.seller_order_json(uuid), core.my_seller_orders(uuid, int), core.my_seller_order(uuid),
  core.earnings_totals(uuid, text, timestamptz, timestamptz), core.company_earnings(uuid, int, timestamptz),
  core.my_earnings(int), core.my_brand_progress(), core.my_inventory()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.my_seller_orders(uuid, int), core.my_seller_order(uuid), core.my_earnings(int),
  core.my_brand_progress(), core.my_inventory()
TO app_web;
