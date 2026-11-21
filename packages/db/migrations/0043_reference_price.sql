-- The sale-price display rule (US-43; PRD "honest sale price"): a reference ("was") price may be
-- shown for a product only when that price was the product's actual published price for at least
-- `reference_price_min_hours` (24) continuous hours immediately before the current price took
-- effect, and the current price is lower. The same rule as referencePrice() in
-- packages/core/src/pricing/reference-price.ts, computed here from core.price_history (in the
-- order it was recorded; consecutive entries at the same price are one run) and core.listing_hide
-- (a listing hidden during that time was not published, so the run is broken). Only the current
-- live price can carry a reference: a history whose last price is not the current version's price
-- shows none.
--
-- core.catalog_products, core.catalog_product and core.store_products (0038) now also return
-- reference_price_paise (NULL when none may be shown). Their other columns are unchanged.

CREATE FUNCTION core.reference_price(p_product uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hours      int := core.config_int(core.current_config_id(), ARRAY['reference_price_min_hours'], 24)::int;
  v_cur        bigint;
  v_cur_start  timestamptz;
  v_prev       bigint;
  v_prev_start timestamptz;
  v_stage      int := 0;
  r            record;
BEGIN
  -- newest first: the current price's run, then the run right before it
  FOR r IN SELECT h.price_paise, h.changed_at FROM core.price_history h WHERE h.product_id = p_product
            ORDER BY h.id DESC LOOP
    IF v_stage = 0 THEN
      IF v_cur IS NULL THEN
        v_cur := r.price_paise;
        v_cur_start := r.changed_at;
      ELSIF r.price_paise = v_cur THEN
        v_cur_start := r.changed_at;
      ELSE
        v_stage := 1;
        v_prev := r.price_paise;
        v_prev_start := r.changed_at;
      END IF;
    ELSIF r.price_paise = v_prev THEN
      v_prev_start := r.changed_at;
    ELSE
      EXIT;
    END IF;
  END LOOP;
  IF v_prev IS NULL OR v_prev <= v_cur OR v_cur_start - v_prev_start < make_interval(hours => v_hours) THEN
    RETURN NULL;
  END IF;
  -- the history's last price is the live price
  IF NOT EXISTS (SELECT 1 FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
                  WHERE p.id = p_product AND v.price_paise = v_cur) THEN
    RETURN NULL;
  END IF;
  -- continuously published: no hide overlaps the earlier price's run
  IF EXISTS (SELECT 1 FROM core.listing_hide h
              WHERE h.product_id = p_product AND h.hidden_at < v_cur_start
                AND (h.lifted_at IS NULL OR h.lifted_at > v_prev_start)) THEN
    RETURN NULL;
  END IF;
  RETURN v_prev;
END $$;

DROP FUNCTION core.catalog_product(uuid);
DROP FUNCTION core.catalog_products(text, uuid, int);
DROP FUNCTION core.store_products(text, uuid, int);

CREATE FUNCTION core.catalog_products(category_slug text, cursor uuid, page_size int)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean, seller_key text,
               store_handle text, inventory_mode text, stock_band text, edition_issued int, edition_supply int,
               reference_price_paise bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.*, core.reference_price(p.id)
    FROM core.product p, LATERAL core.catalog_row(p) r
   WHERE p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL
     AND (catalog_products.category_slug IS NULL OR p.category = catalog_products.category_slug)
     AND (catalog_products.cursor IS NULL OR p.id > catalog_products.cursor)
   ORDER BY p.id
   LIMIT core.page_size(catalog_products.page_size)
$$;

CREATE FUNCTION core.catalog_product(id uuid)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean, seller_key text,
               store_handle text, inventory_mode text, stock_band text, edition_issued int, edition_supply int,
               reference_price_paise bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.*, core.reference_price(p.id) FROM core.product p, LATERAL core.catalog_row(p) r WHERE p.id = catalog_product.id
$$;

CREATE FUNCTION core.store_products(p_handle text, p_cursor uuid, p_page_size int)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean, seller_key text,
               store_handle text, inventory_mode text, stock_band text, edition_issued int, edition_supply int,
               reference_price_paise bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.*, core.reference_price(p.id)
    FROM core.company c
    JOIN core.product p ON p.company_id = c.id
    CROSS JOIN LATERAL core.catalog_row(p) r
   WHERE c.handle IS NOT NULL AND lower(c.handle) = lower(p_handle)
     AND p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL
     AND (p_cursor IS NULL OR p.id > p_cursor)
   ORDER BY p.id
   LIMIT core.page_size(p_page_size)
$$;

REVOKE ALL ON FUNCTION core.reference_price(uuid), core.catalog_products(text, uuid, int), core.catalog_product(uuid),
  core.store_products(text, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.catalog_products(text, uuid, int), core.catalog_product(uuid),
  core.store_products(text, uuid, int) TO app_web;
