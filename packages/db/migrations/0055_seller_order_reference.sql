-- The seller's order reference (seventh security review, major 3).
--
-- 0051 rounded the seller's order times to the minute, but the seller order's id it returned is a
-- UUIDv7 whose first 48 bits are the order's millisecond timestamp (and the list's paging cursor was
-- that id too). Sellers now see, in every seller-facing read, an opaque reference instead:
--   * core.seller_order_ref (owner-only): one row per seller order, `reference` = 'SO-' and 16
--     characters of the coupon alphabet drawn from 80 random bits (pgcrypto), unique. It is
--     written by an AFTER INSERT trigger on core.seller_order (any writer) and never changes, so a
--     reference is stable; being random, it says nothing about the order's time or about any
--     buyer-side id (order group, payment attempt, session, line, unit, shipment, journal).
--   * core.seller_order_json returns `orderRef` (the reference) in place of `sellerOrderId`.
--   * core.my_seller_orders(cursor text, page_size int): newest first as before; the cursor is the
--     reference of the last order of the previous page. core.my_seller_order(reference text):
--     NOT_FOUND for a reference of another company, an unknown or a malformed one. The uuid-taking
--     versions are dropped.
--   * core.my_earnings: `asOf` and the current periods' `to` (the database clock) are rounded down
--     to the minute in the answer (the totals are computed at the clock as before).
-- Audited for other time-ordered or buyer-linkable ids: the order lines carry the product id (public)
-- and the edition serial; no order group, payment attempt, unit or shipment id reaches a seller.

-- ---------------------------------------------------------------- references
CREATE TABLE core.seller_order_ref (
  seller_order_id uuid PRIMARY KEY REFERENCES core.seller_order (id),
  reference       text NOT NULL UNIQUE CHECK (reference ~ '^SO-[A-HJ-NP-Z2-9]{16}$')
);
ALTER TABLE core.seller_order_ref ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.seller_order_ref FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.seller_order_ref USING (false) WITH CHECK (false);
CREATE TRIGGER no_update BEFORE UPDATE ON core.seller_order_ref FOR EACH ROW EXECUTE FUNCTION core.refuse_change();
CREATE TRIGGER no_delete BEFORE DELETE ON core.seller_order_ref FOR EACH ROW EXECUTE FUNCTION core.refuse_delete();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.seller_order_ref FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete();

CREATE FUNCTION core.new_seller_order_reference() RETURNS text
LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'SO-' || substr(core.generate_coupon_code(), 1, 16)
$$;

-- Gives a seller order its reference (a collision, at 80 random bits, is simply drawn again).
CREATE FUNCTION core.give_seller_order_ref(p_seller_order uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_tries int := 0;
BEGIN
  LOOP
    BEGIN
      INSERT INTO core.seller_order_ref (seller_order_id, reference)
      VALUES (p_seller_order, core.new_seller_order_reference())
      ON CONFLICT (seller_order_id) DO NOTHING;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      v_tries := v_tries + 1;
      IF v_tries >= 5 THEN RAISE; END IF;
    END;
  END LOOP;
END $$;

CREATE FUNCTION core.seller_order_ref_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM core.give_seller_order_ref(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER give_reference AFTER INSERT ON core.seller_order
  FOR EACH ROW EXECUTE FUNCTION core.seller_order_ref_on_insert();

-- the orders placed before this migration
DO $$
DECLARE
  v uuid;
BEGIN
  FOR v IN SELECT so.id FROM core.seller_order so ORDER BY so.id LOOP
    PERFORM core.give_seller_order_ref(v);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- the seller's reads
CREATE OR REPLACE FUNCTION core.seller_order_json(p_seller_order uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'orderRef', (SELECT r.reference FROM core.seller_order_ref r WHERE r.seller_order_id = so.id),
    'orderedAt', date_trunc('minute', g.created_at),
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
    'couponCode', (SELECT CASE WHEN cp.is_public THEN cp.code_normalised END
                     FROM core.coupon_redemption r JOIN core.coupon cp ON cp.id = r.coupon_id
                    WHERE r.order_group_id = so.order_group_id AND cp.company_id = so.company_id
                    ORDER BY cp.id LIMIT 1),
    'couponKind', (SELECT CASE WHEN cp.is_public THEN 'PUBLIC' ELSE 'PRIVATE' END
                     FROM core.coupon_redemption r JOIN core.coupon cp ON cp.id = r.coupon_id
                    WHERE r.order_group_id = so.order_group_id AND cp.company_id = so.company_id
                    ORDER BY cp.id LIMIT 1),
    'delivery', (SELECT jsonb_build_object('speed', sh.speed,
                                           'placedAt', date_trunc('minute', sh.placed_at),
                                           'packedAt', date_trunc('minute', sh.packed_at),
                                           'shippedAt', date_trunc('minute', sh.shipped_at),
                                           'outAt', date_trunc('minute', sh.out_at),
                                           'deliveredAt', date_trunc('minute', sh.delivered_at),
                                           'cancelledAt', date_trunc('minute', sh.cancelled_at))
                   FROM core.shipment sh WHERE sh.seller_order_id = so.id),
    'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'productId', l.product_id, 'name', l.snapshot ->> 'name', 'editionSerial', l.edition_serial,
                       'listPaise', l.list_paise::text, 'discountPaise', l.seller_discount_paise::text,
                       'feePaise', l.fee_paise::text) ORDER BY l.line_no), '[]'::jsonb)
                FROM core.order_line l WHERE l.seller_order_id = so.id))
    FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
   WHERE so.id = p_seller_order
$$;

DROP FUNCTION core.my_seller_orders(uuid, int);
DROP FUNCTION core.my_seller_order(uuid);

CREATE FUNCTION core.my_seller_orders(p_cursor text, p_page_size int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company uuid := core.merchant_company();
  v_size    int := core.page_size(p_page_size);
  v_after   uuid;
  v_items   jsonb;
  v_ids     uuid[];
BEGIN
  IF p_cursor IS NOT NULL THEN
    SELECT so.id INTO v_after FROM core.seller_order_ref r JOIN core.seller_order so ON so.id = r.seller_order_id
     WHERE r.reference = p_cursor AND so.company_id = v_company;
    IF v_after IS NULL THEN
      PERFORM core.fail('VALIDATION_FAILED', 'unknown cursor');
    END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(core.seller_order_json(x.id) ORDER BY x.id DESC), '[]'::jsonb), array_agg(x.id ORDER BY x.id DESC)
    INTO v_items, v_ids
    FROM (SELECT so.id FROM core.seller_order so
           WHERE so.company_id = v_company AND (v_after IS NULL OR so.id < v_after)
             AND EXISTS (SELECT 1 FROM core.seller_order_ref r WHERE r.seller_order_id = so.id)
           ORDER BY so.id DESC LIMIT v_size) x;
  RETURN jsonb_build_object('items', v_items,
    'nextCursor', CASE WHEN cardinality(v_ids) = v_size
                       THEN (SELECT r.reference FROM core.seller_order_ref r WHERE r.seller_order_id = v_ids[v_size]) END);
END $$;

CREATE FUNCTION core.my_seller_order(p_reference text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_company uuid := core.merchant_company();
  v_id      uuid;
BEGIN
  SELECT so.id INTO v_id FROM core.seller_order_ref r JOIN core.seller_order so ON so.id = r.seller_order_id
   WHERE r.reference = p_reference AND so.company_id = v_company;
  IF v_id IS NULL THEN
    PERFORM core.fail('NOT_FOUND', 'order not found');
  END IF;
  RETURN core.seller_order_json(v_id);
END $$;

CREATE OR REPLACE FUNCTION core.my_earnings(p_period_days int DEFAULT 7) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e || jsonb_build_object(
           'asOf', date_trunc('minute', (e ->> 'asOf')::timestamptz),
           'current', (e -> 'current') || jsonb_build_object('to', date_trunc('minute', (e #>> '{current,to}')::timestamptz)),
           'staff', jsonb_build_object(
             'current', (e #> '{staff,current}')
                        || jsonb_build_object('to', date_trunc('minute', (e #>> '{staff,current,to}')::timestamptz)),
             'previous', e #> '{staff,previous}'))
    FROM (SELECT core.company_earnings(core.merchant_company(), p_period_days, clock_timestamp()) AS e) x
$$;

REVOKE ALL ON FUNCTION core.new_seller_order_reference(), core.give_seller_order_ref(uuid),
  core.seller_order_ref_on_insert(), core.my_seller_orders(text, int), core.my_seller_order(text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.my_seller_orders(text, int), core.my_seller_order(text) TO app_web;
