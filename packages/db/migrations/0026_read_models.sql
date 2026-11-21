-- Read models for the web app (account, bank, orders, collection, catalog).
--
-- Each is a STABLE SECURITY DEFINER function with a pinned search_path. The account functions
-- derive the actor from the sign-in session (core.actor_id()) and return the actor's own rows
-- only (FORBIDDEN without a session): they take no user id, so user A cannot name user B. They
-- return no personal data: no fingerprints, birthdate, address or other user's ids; the full card
-- number only through core.reveal_card_number after a recent sign-in. The catalog functions need
-- no actor and return PUBLISHED products with a current version only (never drafts or any other
-- status). Money is bigint paise (decimal strings inside jsonb).
--
-- Parameters are positional; where a parameter would share a name with an output column it is
-- named differently (my_order(group_id), catalog_products(category_slug, ...), catalog_product(id)).
--
-- Pages: `page_size` defaults to 20 and is capped at `page_size_max` (50, configuration); the
-- cursor is the last row's key from the previous page (NULL for the first page).

CREATE FUNCTION core.page_size(requested int) RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF requested IS NOT NULL AND requested < 1 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'page size is at least 1');
  END IF;
  RETURN least(COALESCE(requested, 20),
               core.config_int(core.current_config_id(), ARRAY['page_size_max'], 50)::int);
END $$;

CREATE FUNCTION core.require_actor() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  RETURN actor;
END $$;

-- The seller's public name: the company's, or "DeluluMart Originals" for platform seed stock.
CREATE FUNCTION core.seller_display_name(company_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN company_id IS NULL THEN 'DeluluMart Originals'
              ELSE (SELECT c.name FROM core.company c WHERE c.id = company_id) END
$$;

-- ---------------------------------------------------------------- wallet and card
-- Zero rows before provisioning.
CREATE FUNCTION core.my_wallet()
RETURNS TABLE (balance_paise bigint, bank_alias text, delulupay_id text, card_id uuid, card_status text,
               card_last_four text, pin_set boolean, creator_unlocked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT w.available_paise, ba.alias, ba.upi_style_id, vc.id, vc.status, right(vc.card_number, 4),
         vc.pin_hash IS NOT NULL,
         EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = la.user_id)
    FROM ledger.ledger_account la
    JOIN ledger.wallet w ON w.account_id = la.id
    JOIN core.bank_account ba ON ba.ledger_account_id = la.id
    LEFT JOIN core.virtual_card vc ON vc.bank_account_id = ba.id AND vc.status IN ('ACTIVE', 'FROZEN')
   WHERE la.type = 'USER' AND la.user_id = core.require_actor()
$$;

-- The full card number (US-15: "revealed only to the owner"), only with a sign-in session created
-- within the last `recent_auth_seconds` (300) (LLD §11.1): REAUTH_REQUIRED otherwise.
CREATE FUNCTION core.reveal_card_number(card_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.require_actor();
  num   text;
BEGIN
  SELECT vc.card_number INTO num FROM core.virtual_card vc
   WHERE vc.id = reveal_card_number.card_id AND vc.user_id = actor;
  IF NOT FOUND THEN
    PERFORM core.fail('CARD_NOT_OWNED', 'card not found for this user');
  END IF;
  PERFORM core.require_recent_sign_in();
  RETURN num;
END $$;

-- ---------------------------------------------------------------- statement
-- The actor's own postings, newest first (cursor: the last posting_id seen), with the journal's
-- event type and time, the signed amount, the balance after the posting and the order group.
CREATE FUNCTION core.my_statement(cursor bigint, page_size int)
RETURNS TABLE (posting_id bigint, journal_id uuid, event_type text, created_at timestamptz, amount_paise bigint,
               balance_after_paise bigint, order_group_id uuid, memo text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH acct AS (
    SELECT la.id FROM ledger.ledger_account la WHERE la.type = 'USER' AND la.user_id = core.require_actor()
  ), own AS (
    SELECT p.id, p.journal_id, p.amount, p.memo,
           sum(p.amount) OVER (ORDER BY p.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS after
      FROM ledger.posting p WHERE p.account_id = (SELECT id FROM acct)
  )
  SELECT o.id, o.journal_id, j.event_type, j.created_at, o.amount, o.after::bigint, j.order_group_id, o.memo
    FROM own o JOIN ledger.journal j ON j.id = o.journal_id
   WHERE my_statement.cursor IS NULL OR o.id < my_statement.cursor
   ORDER BY o.id DESC
   LIMIT core.page_size(my_statement.page_size)
$$;

-- ---------------------------------------------------------------- orders
-- One order group as its buyer sees it: seller orders (seller name, what the buyer paid, delivery
-- speed and stage times) with their lines (product name as bought, amounts). No address, no
-- seller-side finances, no other user's id.
CREATE FUNCTION core.order_group_json(group_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sellerOrderId', so.id,
           'sellerType', so.seller_type,
           'sellerName', core.seller_display_name(so.company_id),
           'status', so.status,
           'listPaise', so.list_paise::text,
           'sellerDiscountPaise', so.seller_discount_paise::text,
           'platformDiscountPaise', so.platform_discount_paise::text,
           'deliveryFeePaise', so.delivery_fee_buyer_paise::text,
           'totalPaise', (so.list_paise - so.seller_discount_paise - so.platform_discount_paise
                          + so.delivery_fee_buyer_paise)::text,
           'shipment', (SELECT jsonb_build_object('speed', sh.speed, 'placedAt', sh.placed_at, 'packedAt', sh.packed_at,
                                                  'shippedAt', sh.shipped_at, 'outAt', sh.out_at,
                                                  'deliveredAt', sh.delivered_at, 'cancelledAt', sh.cancelled_at)
                          FROM core.shipment sh WHERE sh.seller_order_id = so.id),
           'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                              'orderLineId', l.id, 'productId', l.product_id, 'name', l.snapshot ->> 'name',
                              'listPaise', l.list_paise::text, 'sellerDiscountPaise', l.seller_discount_paise::text,
                              'platformDiscountPaise', l.platform_discount_paise::text,
                              'editionSerial', l.edition_serial) ORDER BY l.line_no), '[]'::jsonb)
                       FROM core.order_line l WHERE l.seller_order_id = so.id)
         ) ORDER BY so.id), '[]'::jsonb)
    FROM core.seller_order so WHERE so.order_group_id = group_id
$$;

CREATE FUNCTION core.my_orders(cursor uuid, page_size int)
RETURNS TABLE (order_group_id uuid, created_at timestamptz, total_paise bigint, payment_reference text,
               seller_orders jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT g.id, g.created_at, g.total_paise, pa.reference, core.order_group_json(g.id)
    FROM core.order_group g JOIN core.payment_attempt pa ON pa.id = g.payment_attempt_id
   WHERE g.buyer_user_id = core.require_actor()
     AND (my_orders.cursor IS NULL OR g.id < my_orders.cursor)
   ORDER BY g.id DESC
   LIMIT core.page_size(my_orders.page_size)
$$;

-- Zero rows unless the order group is the actor's own.
CREATE FUNCTION core.my_order(group_id uuid)
RETURNS TABLE (order_group_id uuid, created_at timestamptz, total_paise bigint, payment_reference text,
               seller_orders jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT g.id, g.created_at, g.total_paise, pa.reference, core.order_group_json(g.id)
    FROM core.order_group g JOIN core.payment_attempt pa ON pa.id = g.payment_attempt_id
   WHERE g.id = my_order.group_id AND g.buyer_user_id = core.require_actor()
$$;

-- ---------------------------------------------------------------- collection
CREATE FUNCTION core.my_collection()
RETURNS TABLE (ownership_id uuid, product_id uuid, name text, order_line_id uuid, state text, acquired_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT o.id, o.product_id, l.snapshot ->> 'name', o.order_line_id, o.state, g.created_at
    FROM core.ownership o
    JOIN core.order_line l ON l.id = o.order_line_id
    JOIN core.seller_order so ON so.id = l.seller_order_id
    JOIN core.order_group g ON g.id = so.order_group_id
   WHERE o.user_id = core.require_actor()
   ORDER BY g.created_at DESC, o.id DESC
$$;

-- Which of these products (at most 100) the actor already owns (in any state: no rebuy).
CREATE FUNCTION core.owns_products(product_ids uuid[]) RETURNS TABLE (product_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.require_actor();
BEGIN
  IF product_ids IS NULL OR cardinality(product_ids) > 100 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'ask about 0-100 products at a time');
  END IF;
  RETURN QUERY SELECT o.product_id FROM core.ownership o
                WHERE o.user_id = actor AND o.product_id = ANY (owns_products.product_ids)
                ORDER BY o.product_id;
END $$;

-- ---------------------------------------------------------------- public catalog
CREATE FUNCTION core.catalog_row(p core.product)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.id, v.name, v.hook, v.description, v.alt_text, v.price_paise, p.category, v.template_id,
         core.seller_display_name(p.company_id),
         p.inventory_mode = 'UNLIMITED_SEED' OR p.available_units > 0, p.zap_flag
    FROM core.product_version v
   WHERE v.id = p.current_version_id AND v.product_id = p.id AND p.status = 'PUBLISHED'
$$;

-- Published products, optionally of one category, by product id (cursor: the last id seen).
CREATE FUNCTION core.catalog_products(category_slug text, cursor uuid, page_size int)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.*
    FROM core.product p, LATERAL core.catalog_row(p) r
   WHERE p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL
     AND (catalog_products.category_slug IS NULL OR p.category = catalog_products.category_slug)
     AND (catalog_products.cursor IS NULL OR p.id > catalog_products.cursor)
   ORDER BY p.id
   LIMIT core.page_size(catalog_products.page_size)
$$;

-- One published product, or zero rows.
CREATE FUNCTION core.catalog_product(id uuid)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.* FROM core.product p, LATERAL core.catalog_row(p) r WHERE p.id = catalog_product.id
$$;

REVOKE ALL ON FUNCTION core.page_size(int), core.require_actor(), core.seller_display_name(uuid), core.my_wallet(),
  core.reveal_card_number(uuid), core.my_statement(bigint, int), core.order_group_json(uuid),
  core.my_orders(uuid, int), core.my_order(uuid), core.my_collection(), core.owns_products(uuid[]),
  core.catalog_row(core.product), core.catalog_products(text, uuid, int), core.catalog_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.my_wallet(), core.reveal_card_number(uuid), core.my_statement(bigint, int),
  core.my_orders(uuid, int), core.my_order(uuid), core.my_collection(), core.owns_products(uuid[]),
  core.catalog_products(text, uuid, int), core.catalog_product(uuid),
  core.page_size(int) TO app_web;   -- page_size: the effective page size, for the next-page cursor
-- the money path shows the balance before paying and refuses products already owned
GRANT EXECUTE ON FUNCTION core.my_wallet(), core.owns_products(uuid[]) TO app_pay;
