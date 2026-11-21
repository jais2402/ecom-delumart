-- The cart (PRD R2.2, LLD §3.9 `cart_line`, §8.2 Cart).
--
-- One cart per person: up to `cart_max_lines` (20, configuration) lines, quantity one per
-- product. It is a convenience list: it reserves no stock and guarantees no price; checkout
-- re-validates every line (core.resolve_cart, 0018) and is all-or-nothing.
--
-- core.cart_line has row-level security on and no grant to any application role: it is read
-- and written only through the SECURITY DEFINER functions below, each of which derives the actor
-- from the sign-in session (core.require_actor(), 0026) and takes no user id, so user A can never
-- name, read or change user B's cart. Refusals are DM001 with the stable code in HINT.
--
-- Every function returns the actor's cart as jsonb {lines: [...]} (money as decimal strings):
--   productId, versionId (current), name, hook, altText, templateId, pricePaise, category,
--   sellerKey ('SEED' or the company id), sellerName ("DeluluMart Originals" for seed),
--   available (published and in stock), offersExpress, zapAvailable, freeStandardDelivery,
--   issue (NULL, or why the line cannot be bought now: UNAVAILABLE, ALREADY_OWNED,
--   SELF_PURCHASE, SOLD_OUT), addedAt; in the order the lines were added.
-- A product hidden or unpublished after it was added stays in the cart as an UNAVAILABLE line.
--
-- Concurrent adds of one actor serialise on the actor's own transaction-level advisory lock
-- (core.lock_actor, 0018), so the line limit holds under concurrency. The cart rows are not in
-- the canonical lock order (LLD §4): they are only ever locked by their owner's own calls, and
-- the purchase removes bought lines last (0029).

CREATE TABLE core.cart_line (
  user_id    uuid NOT NULL REFERENCES core.user_profile (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES core.product (id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX cart_line_product ON core.cart_line (product_id);

ALTER TABLE core.cart_line ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.cart_line FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
-- No grant exists; this policy only says what a grant would have to respect: one's own lines.
CREATE POLICY own_lines ON core.cart_line FOR SELECT TO app_web, app_pay USING (user_id = core.actor_id());

-- ---------------------------------------------------------------- reading
CREATE FUNCTION core.cart_json(actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('lines', COALESCE(jsonb_agg(jsonb_build_object(
           'productId', p.id,
           'versionId', v.id,
           'name', v.name,
           'hook', v.hook,
           'altText', v.alt_text,
           'templateId', v.template_id,
           'pricePaise', v.price_paise::text,
           'category', p.category,
           'sellerKey', COALESCE(p.company_id::text, 'SEED'),
           'sellerName', core.seller_display_name(p.company_id),
           'available', x.published AND x.in_stock,
           'offersExpress', p.offers_express,
           'zapAvailable', CASE WHEN p.company_id IS NULL THEN p.zap_flag
                                ELSE EXISTS (SELECT 1 FROM core.inventory_unit u
                                               JOIN core.warehouse w ON w.id = u.warehouse_id
                                              WHERE u.product_id = p.id AND u.state = 'AVAILABLE' AND w.zap_hub) END,
           'freeStandardDelivery', p.free_standard_delivery,
           'issue', CASE WHEN NOT x.published THEN 'UNAVAILABLE'
                         WHEN x.owned THEN 'ALREADY_OWNED'
                         WHEN x.own_company THEN 'SELF_PURCHASE'
                         WHEN NOT x.in_stock THEN 'SOLD_OUT' END,
           'addedAt', cl.added_at)
         ORDER BY cl.added_at, cl.product_id), '[]'::jsonb))
    FROM core.cart_line cl
    JOIN core.product p ON p.id = cl.product_id
    -- the current version; a product without one shows its latest (versions are immutable)
    CROSS JOIN LATERAL (SELECT pv.* FROM core.product_version pv WHERE pv.product_id = p.id
                         ORDER BY (pv.id = p.current_version_id) DESC, pv.revision DESC LIMIT 1) v
    CROSS JOIN LATERAL (SELECT p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL AS published,
                               p.inventory_mode = 'UNLIMITED_SEED' OR p.available_units > 0 AS in_stock,
                               EXISTS (SELECT 1 FROM core.ownership o
                                        WHERE o.user_id = actor AND o.product_id = p.id) AS owned,
                               EXISTS (SELECT 1 FROM core.company c
                                        WHERE c.id = p.company_id AND c.owner_user_id = actor) AS own_company) x
   WHERE cl.user_id = actor
$$;

CREATE FUNCTION core.my_cart() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.cart_json(core.require_actor())
$$;

-- ---------------------------------------------------------------- writing
-- Why the actor may not add this product now, as [code, message]; NULL when it may.
CREATE FUNCTION core.cart_add_problem(actor uuid, p_product_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
                  WHERE p.id = p_product_id AND v.product_id = p.id AND p.status = 'PUBLISHED') THEN
    RETURN ARRAY['PRODUCT_UNAVAILABLE', 'that product is not available'];
  END IF;
  IF EXISTS (SELECT 1 FROM core.ownership o WHERE o.user_id = actor AND o.product_id = p_product_id) THEN
    RETURN ARRAY['ALREADY_OWNED', 'you already own that product'];
  END IF;
  IF EXISTS (SELECT 1 FROM core.product p JOIN core.company c ON c.id = p.company_id
              WHERE p.id = p_product_id AND c.owner_user_id = actor) THEN
    RETURN ARRAY['SELF_PURCHASE', 'you cannot buy from your own company'];
  END IF;
  IF (SELECT count(*) FROM core.cart_line cl WHERE cl.user_id = actor)
     >= core.config_int(core.current_config_id(), ARRAY['cart_max_lines'], 20) THEN
    RETURN ARRAY['CART_FULL', 'your cart is full'];
  END IF;
  RETURN NULL;
END $$;

-- The actor, signed in, with a profile (created at the phone step), holding the cart lock.
CREATE FUNCTION core.cart_actor() RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.require_actor();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.user_profile up WHERE up.id = actor) THEN
    PERFORM core.fail('PHONE_REQUIRED', 'verify your phone number to use a cart');
  END IF;
  PERFORM core.lock_actor('core.cart_line', actor);
  RETURN actor;
END $$;

-- Adds a published product; a product already in the cart is a no-op success.
CREATE FUNCTION core.cart_add(product_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.cart_actor();
  problem text[];
BEGIN
  IF cart_add.product_id IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'productId is required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.cart_line cl WHERE cl.user_id = actor AND cl.product_id = cart_add.product_id) THEN
    problem := core.cart_add_problem(actor, cart_add.product_id);
    IF problem IS NOT NULL THEN
      PERFORM core.fail(problem[1], problem[2]);
    END IF;
    INSERT INTO core.cart_line (user_id, product_id, added_at)
    VALUES (actor, cart_add.product_id, clock_timestamp());
  END IF;
  RETURN core.cart_json(actor);
END $$;

CREATE FUNCTION core.cart_remove(product_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.require_actor();
BEGIN
  PERFORM core.lock_actor('core.cart_line', actor);
  DELETE FROM core.cart_line cl WHERE cl.user_id = actor AND cl.product_id = cart_remove.product_id;
  RETURN core.cart_json(actor);
END $$;

CREATE FUNCTION core.cart_clear() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.require_actor();
BEGIN
  PERFORM core.lock_actor('core.cart_line', actor);
  DELETE FROM core.cart_line cl WHERE cl.user_id = actor;
  RETURN core.cart_json(actor);
END $$;

-- Sign-in merge of the browser cart: adds each eligible product (in the order given) while there
-- is room, and skips the others silently, each with the code cart_add would have refused it
-- with. Returns the cart plus skipped: [{productId, reason}].
CREATE FUNCTION core.cart_merge(product_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.cart_actor();
  pid     uuid;
  problem text[];
  skipped jsonb := '[]';
BEGIN
  IF product_ids IS NULL
     OR cardinality(product_ids) > core.config_int(core.current_config_id(), ARRAY['cart_max_lines'], 20) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'merge at most a full cart of products');
  END IF;
  FOR pid IN SELECT t.id FROM unnest(product_ids) WITH ORDINALITY AS t(id, o) WHERE t.id IS NOT NULL ORDER BY t.o LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM core.cart_line cl WHERE cl.user_id = actor AND cl.product_id = pid);
    problem := core.cart_add_problem(actor, pid);
    IF problem IS NOT NULL THEN
      skipped := skipped || jsonb_build_array(jsonb_build_object('productId', pid, 'reason', problem[1]));
      CONTINUE;
    END IF;
    INSERT INTO core.cart_line (user_id, product_id, added_at) VALUES (actor, pid, clock_timestamp());
  END LOOP;
  RETURN core.cart_json(actor) || jsonb_build_object('skipped', skipped);
END $$;

-- ---------------------------------------------------------------- pricing inputs
-- The cart preview's step 1: exactly what core.checkout_inputs resolves for a checkout of these
-- choices ({productIds, speedBySeller, couponCode?}), through the same core.resolve_cart, without
-- an idempotency key: {inputs} or {error}. A coupon code that matches nothing is counted for the
-- actor as at checkout (the preview is no unlimited oracle for codes), so it commits.
CREATE FUNCTION core.cart_quote_inputs(choices jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.require_actor();
BEGIN
  RETURN core.resolve_cart(actor, choices);
END $$;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION core.cart_json(uuid), core.my_cart(), core.cart_add_problem(uuid, uuid), core.cart_actor(),
  core.cart_add(uuid), core.cart_remove(uuid), core.cart_clear(), core.cart_merge(uuid[]),
  core.cart_quote_inputs(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.my_cart(), core.cart_add(uuid), core.cart_remove(uuid), core.cart_clear(),
  core.cart_merge(uuid[]) TO app_web, app_pay;
GRANT EXECUTE ON FUNCTION core.cart_quote_inputs(jsonb) TO app_pay;
