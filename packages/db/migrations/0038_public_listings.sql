-- Player listings, part 4: the public reads (no actor needed; app_web).
--
-- core.catalog_products and core.catalog_product (0026) now also return, for every PUBLISHED
-- product with a current version (seed or player-made): the seller key ('SEED' or the company id),
-- the store handle (NULL for seed stock), the inventory mode, a stock band (UNLIMITED, IN_STOCK,
-- LOW at or below `listing_low_stock_threshold` (5) units, SOLD_OUT) and, for an EXCLUSIVE edition,
-- how many were issued of its supply. Zap delivery of a player product is available when an
-- AVAILABLE unit is in the company's Zap hub (the rule of core.cart_json and checkout, 0018/0028).
-- core.store_products(handle, cursor, page_size) lists one store's published products.
-- HIDDEN, ARCHIVED, drafts and unapproved revisions never appear: only the current version of a
-- PUBLISHED product does. core.product_unavailable(id) tells a product page that a product was
-- published once and is now hidden or archived (an explicit "unavailable", so collections can
-- show a placeholder), without any of its text.

DROP FUNCTION core.catalog_product(uuid);
DROP FUNCTION core.catalog_products(text, uuid, int);
DROP FUNCTION core.catalog_row(core.product);

CREATE FUNCTION core.catalog_row(p core.product)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean, seller_key text,
               store_handle text, inventory_mode text, stock_band text, edition_issued int, edition_supply int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.id, v.name, v.hook, v.description, v.alt_text, v.price_paise, p.category, v.template_id,
         core.seller_display_name(p.company_id),
         p.inventory_mode = 'UNLIMITED_SEED' OR p.available_units > 0,
         CASE WHEN p.company_id IS NULL THEN p.zap_flag
              ELSE EXISTS (SELECT 1 FROM core.inventory_unit u JOIN core.warehouse w ON w.id = u.warehouse_id
                            WHERE u.product_id = p.id AND u.state = 'AVAILABLE' AND w.zap_hub) END,
         COALESCE(p.company_id::text, 'SEED'),
         (SELECT c.handle FROM core.company c WHERE c.id = p.company_id),
         p.inventory_mode,
         CASE WHEN p.inventory_mode = 'UNLIMITED_SEED' THEN 'UNLIMITED'
              WHEN p.available_units <= 0 THEN 'SOLD_OUT'
              WHEN p.available_units <= core.config_int(core.current_config_id(), ARRAY['listing_low_stock_threshold'], 5)
                THEN 'LOW'
              ELSE 'IN_STOCK' END,
         CASE WHEN p.inventory_mode = 'EXCLUSIVE' THEN
           (SELECT count(*)::int FROM core.inventory_unit u WHERE u.product_id = p.id AND u.state IN ('ISSUED', 'REVOKED_ISSUED')) END,
         CASE WHEN p.inventory_mode = 'EXCLUSIVE' THEN
           COALESCE((SELECT e.supply FROM core.exclusive_edition e WHERE e.product_id = p.id), p.exclusive_supply) END
    FROM core.product_version v
   WHERE v.id = p.current_version_id AND v.product_id = p.id AND p.status = 'PUBLISHED'
$$;

CREATE FUNCTION core.catalog_products(category_slug text, cursor uuid, page_size int)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean, seller_key text,
               store_handle text, inventory_mode text, stock_band text, edition_issued int, edition_supply int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.*
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
               store_handle text, inventory_mode text, stock_band text, edition_issued int, edition_supply int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.* FROM core.product p, LATERAL core.catalog_row(p) r WHERE p.id = catalog_product.id
$$;

-- One store's published products, by product id (cursor: the last id seen).
CREATE FUNCTION core.store_products(p_handle text, p_cursor uuid, p_page_size int)
RETURNS TABLE (product_id uuid, name text, hook text, description text, alt_text text, price_paise bigint,
               category text, template_id int, seller_name text, available boolean, zap boolean, seller_key text,
               store_handle text, inventory_mode text, stock_band text, edition_issued int, edition_supply int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.*
    FROM core.company c
    JOIN core.product p ON p.company_id = c.id
    CROSS JOIN LATERAL core.catalog_row(p) r
   WHERE c.handle IS NOT NULL AND lower(c.handle) = lower(p_handle)
     AND p.status = 'PUBLISHED' AND p.current_version_id IS NOT NULL
     AND (p_cursor IS NULL OR p.id > p_cursor)
   ORDER BY p.id
   LIMIT core.page_size(p_page_size)
$$;

-- A product that was published once and is now hidden or archived: true; anything else false.
CREATE FUNCTION core.product_unavailable(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM core.product p
                  WHERE p.id = p_id AND p.published_at IS NOT NULL AND p.status IN ('HIDDEN', 'ARCHIVED'))
$$;

REVOKE ALL ON FUNCTION core.catalog_row(core.product), core.catalog_products(text, uuid, int),
  core.catalog_product(uuid), core.store_products(text, uuid, int), core.product_unavailable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.catalog_products(text, uuid, int), core.catalog_product(uuid),
  core.store_products(text, uuid, int), core.product_unavailable(uuid) TO app_web;
