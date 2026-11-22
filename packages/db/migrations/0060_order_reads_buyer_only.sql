-- Order times and buyer-side ids are the buyer's alone (eighth security review, major 1 and minor 7).
--
-- 1. Direct reads. A seller (app_web with the owner's session) could read its seller orders'
--    UUIDv7 ids and their buyer-side order group, the shipments' exact times and address, the
--    lines' ids and units; anyone (no session) could read every unit's order line (the sale's v7
--    id) of any published product; and the seller could read the purchase journal (v7 id, exact
--    time, the buyer's order group) and its own postings' journal and seller order ids. Now:
--      * core.seller_order (app_web): only the buyer's own rows (the policy no longer admits the
--        seller's company). core.order_line and core.shipment follow it (their policies admit a
--        row only through a visible seller order). Sellers read their orders only through the
--        definer reads (opaque reference, minute-rounded times; 0051, 0055).
--      * core.inventory_unit: app_web and app_pay keep id, product, warehouse, serial and state;
--        order_line_id (the sale linkage) is no longer readable by any application role.
--      * ledger.journal: a journal is readable by a party to it (as before) only when it belongs
--        to no order or to the reader's own order as its buyer (ledger.journal_readable, definer).
--      * ledger.posting: journal_id and seller_order_id are no longer readable by app_web or
--        app_pay (the statement read returns what the account holder may see).
--      * core.my_statement: for a posting of an order the reader did not buy (a sale credited to
--        a seller), journal_id and order_group_id are null and the time is rounded to the minute.
-- 2. Polling (minor 7). A seller order becomes visible to the seller-facing reads only once the
--    minute in which it was placed has ended (core.seller_visible_before(): the start of the
--    current minute). The order list and detail, earnings (computed as of that instant, which is
--    also `asOf`), brand progress and the stock and warehouse figures of my_inventory (a unit sold
--    in the current minute still counts as available) all use it, so they agree with one another.

-- ---------------------------------------------------------------- 1. direct reads
DROP POLICY seller_order_parties ON core.seller_order;
CREATE POLICY seller_order_buyer ON core.seller_order FOR SELECT TO app_web
  USING (buyer_user_id = core.actor_id());

REVOKE SELECT ON core.inventory_unit FROM app_web, app_pay;
GRANT SELECT (id, product_id, warehouse_id, serial, state) ON core.inventory_unit TO app_web, app_pay;

CREATE FUNCTION ledger.journal_readable(p_journal uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM ledger.journal j
      JOIN ledger.posting p ON p.journal_id = j.id
      JOIN ledger.ledger_account a ON a.id = p.account_id AND a.type = 'USER' AND a.user_id = core.actor_id()
     WHERE j.id = p_journal
       AND (j.order_group_id IS NULL
            OR EXISTS (SELECT 1 FROM core.order_group g
                        WHERE g.id = j.order_group_id AND g.buyer_user_id = core.actor_id())))
$$;
REVOKE ALL ON FUNCTION ledger.journal_readable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.journal_readable(uuid) TO app_web, app_pay;

DROP POLICY web_own_read ON ledger.journal;
DROP POLICY pay_own_read ON ledger.journal;
CREATE POLICY web_own_read ON ledger.journal FOR SELECT TO app_web USING (ledger.journal_readable(id));
CREATE POLICY pay_own_read ON ledger.journal FOR SELECT TO app_pay USING (ledger.journal_readable(id));

REVOKE SELECT ON ledger.posting FROM app_web, app_pay;
GRANT SELECT (id, account_id, amount, memo) ON ledger.posting TO app_web, app_pay;

CREATE OR REPLACE FUNCTION core.my_statement(cursor bigint, page_size integer)
RETURNS TABLE(posting_id bigint, journal_id uuid, event_type text, created_at timestamptz, amount_paise bigint,
              balance_after_paise bigint, order_group_id uuid, memo text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH acct AS (
    SELECT la.id, la.user_id FROM ledger.ledger_account la WHERE la.type = 'USER' AND la.user_id = core.require_actor()
  ), own AS (
    SELECT p.id, p.journal_id, p.amount, p.memo,
           sum(p.amount) OVER (ORDER BY p.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS after
      FROM ledger.posting p WHERE p.account_id = (SELECT id FROM acct)
  )
  SELECT o.id,
         CASE WHEN x.theirs THEN NULL ELSE o.journal_id END,
         j.event_type,
         CASE WHEN x.theirs THEN date_trunc('minute', j.created_at) ELSE j.created_at END,
         o.amount, o.after::bigint,
         CASE WHEN x.theirs THEN NULL ELSE j.order_group_id END,
         o.memo
    FROM own o JOIN ledger.journal j ON j.id = o.journal_id
    CROSS JOIN LATERAL (
      SELECT j.order_group_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM core.order_group g
                WHERE g.id = j.order_group_id AND g.buyer_user_id = (SELECT user_id FROM acct)) AS theirs) x
   WHERE my_statement.cursor IS NULL OR o.id < my_statement.cursor
   ORDER BY o.id DESC
   LIMIT core.page_size(my_statement.page_size)
$$;

-- ---------------------------------------------------------------- 2. the minute boundary
CREATE FUNCTION core.seller_visible_before() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT date_trunc('minute', clock_timestamp())
$$;
REVOKE ALL ON FUNCTION core.seller_visible_before() FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.my_seller_orders(p_cursor text, p_page_size int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company uuid := core.merchant_company();
  v_size    int := core.page_size(p_page_size);
  v_before  timestamptz := core.seller_visible_before();
  v_after   uuid;
  v_items   jsonb;
  v_ids     uuid[];
BEGIN
  IF p_cursor IS NOT NULL THEN
    SELECT so.id INTO v_after
      FROM core.seller_order_ref r JOIN core.seller_order so ON so.id = r.seller_order_id
      JOIN core.order_group g ON g.id = so.order_group_id
     WHERE r.reference = p_cursor AND so.company_id = v_company AND g.created_at < v_before;
    IF v_after IS NULL THEN
      PERFORM core.fail('VALIDATION_FAILED', 'unknown cursor');
    END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(core.seller_order_json(x.id) ORDER BY x.id DESC), '[]'::jsonb), array_agg(x.id ORDER BY x.id DESC)
    INTO v_items, v_ids
    FROM (SELECT so.id FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
           WHERE so.company_id = v_company AND (v_after IS NULL OR so.id < v_after)
             AND g.created_at < v_before
             AND EXISTS (SELECT 1 FROM core.seller_order_ref r WHERE r.seller_order_id = so.id)
           ORDER BY so.id DESC LIMIT v_size) x;
  RETURN jsonb_build_object('items', v_items,
    'nextCursor', CASE WHEN cardinality(v_ids) = v_size
                       THEN (SELECT r.reference FROM core.seller_order_ref r WHERE r.seller_order_id = v_ids[v_size]) END);
END $$;

CREATE OR REPLACE FUNCTION core.my_seller_order(p_reference text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company uuid := core.merchant_company();
  v_id      uuid;
BEGIN
  SELECT so.id INTO v_id
    FROM core.seller_order_ref r JOIN core.seller_order so ON so.id = r.seller_order_id
    JOIN core.order_group g ON g.id = so.order_group_id
   WHERE r.reference = p_reference AND so.company_id = v_company AND g.created_at < core.seller_visible_before();
  IF v_id IS NULL THEN
    PERFORM core.fail('NOT_FOUND', 'order not found');
  END IF;
  RETURN core.seller_order_json(v_id);
END $$;

CREATE OR REPLACE FUNCTION core.my_earnings(p_period_days int DEFAULT 7) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.company_earnings(core.merchant_company(), p_period_days, core.seller_visible_before())
$$;

CREATE OR REPLACE FUNCTION core.my_brand_progress() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company   uuid := core.merchant_company();
  v_cfg       int := core.current_config_id();
  v_threshold bigint := core.config_paise(v_cfg, ARRAY['brand_threshold_paise'], 10000000000);
  v_min       bigint := core.config_int(v_cfg, ARRAY['brand_min_buyers'], 5);
  v_age       int := core.config_int(v_cfg, ARRAY['brand_buyer_min_age_hours'], 24)::int;
  v_parties   uuid[] := core.company_party_ids(v_company);
  v_before    timestamptz := core.seller_visible_before();
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
     AND so.qualifies_for_progression AND NOT (so.buyer_user_id = ANY (v_parties))
     AND g.created_at < v_before;
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

CREATE OR REPLACE FUNCTION core.my_inventory() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH co AS (SELECT core.merchant_company() AS id),
  low AS (SELECT core.config_int(core.current_config_id(), ARRAY['listing_low_stock_threshold'], 5) AS n),
  -- units issued to an order placed in the current minute: still shown as available (minor 7)
  recent AS (
    SELECT u.id, u.product_id, u.warehouse_id
      FROM core.inventory_unit u
      JOIN core.order_line l ON l.id = u.order_line_id
      JOIN core.seller_order so ON so.id = l.seller_order_id
      JOIN core.order_group g ON g.id = so.order_group_id
     WHERE so.company_id = (SELECT id FROM co) AND u.state = 'ISSUED'
       AND g.created_at >= core.seller_visible_before())
  SELECT jsonb_build_object(
    'lowStockThreshold', (SELECT n FROM low),
    'warehouses', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'id', w.id, 'kind', w.kind, 'capacity', w.capacity, 'used', w.used + r.n,
                      'free', w.capacity - w.used - r.n, 'zapHub', w.zap_hub) ORDER BY w.id), '[]'::jsonb)
                     FROM core.warehouse w
                     CROSS JOIN LATERAL (SELECT count(*) AS n FROM recent WHERE recent.warehouse_id = w.id) r
                    WHERE w.company_id = (SELECT id FROM co)),
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
                     SELECT count(*) FILTER (WHERE u.state = 'AVAILABLE' OR rc.id IS NOT NULL) AS available,
                            count(*) FILTER (WHERE u.state IN ('ISSUED', 'REVOKED_ISSUED') AND rc.id IS NULL) AS issued,
                            count(*) FILTER (WHERE u.state = 'RETIRED_UNSOLD') AS retired
                       FROM core.inventory_unit u LEFT JOIN recent rc ON rc.id = u.id
                      WHERE u.product_id = p.id) st
                  WHERE p.company_id = (SELECT id FROM co) AND p.published_at IS NOT NULL))
$$;
