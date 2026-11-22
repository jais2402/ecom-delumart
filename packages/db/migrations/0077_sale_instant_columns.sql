-- Ninth security review, minor 5: nothing a seller, a stranger or a caller without a session can
-- read ticks at the instant of a sale (the seller-visibility delay of 0060 cannot be bypassed).
--
-- 1. core.my_coupons() showed `redeemed` and `discountGivenPaise` at once: it now counts only
--    redemptions of orders placed before core.seller_visible_before() (the current minute's start,
--    0060), like the seller's orders, earnings and stock.
-- 2. By direct SQL as app_web / app_pay (even with no session) these columns were readable and
--    changed in the purchase transaction itself:
--      core.inventory_unit.state      (each unit's AVAILABLE -> ISSUED)
--      core.warehouse.used            (one per unit sold)
--      core.coupon.redeemed           (one per redemption)
--      core.product.available_units   (one per unit sold; found by the generated diff test)
--    They are revoked from both roles. Nothing in the application reads them directly: the
--    storefront gets stock from the definer functions of 0038 (a band: UNLIMITED / IN_STOCK /
--    LOW at or below `listing_low_stock_threshold` / SOLD_OUT, and the `available` flag), the
--    owner gets exact stock and warehouse use from core.my_inventory() (delayed, 0060), coupons
--    from core.my_coupons() (delayed, above) and core.store_coupons() (a public coupon leaves the
--    store page when it is used up). What a stranger still sees change at a sale: the band when it
--    crosses LOW or SOLD_OUT, the available flag at zero, a used-up public coupon leaving the
--    store page, and an EXCLUSIVE edition's issued count (PRD §7.16 "edition state": "n of N").

CREATE OR REPLACE FUNCTION core.my_coupons() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH co AS (SELECT c.id FROM core.company c WHERE c.owner_user_id = core.require_actor()),
  seen AS (
    SELECT r.coupon_id, count(*) AS n, COALESCE(SUM(r.discount_paise), 0) AS given
      FROM core.coupon_redemption r
      JOIN core.order_group g ON g.id = r.order_group_id
      JOIN core.coupon cp ON cp.id = r.coupon_id
     WHERE cp.company_id = (SELECT id FROM co) AND g.created_at < core.seller_visible_before()
     GROUP BY r.coupon_id)
  SELECT jsonb_build_object(
    'items', COALESCE((
      SELECT jsonb_agg(core.coupon_terms_json(cp) || jsonb_build_object(
               'couponId', cp.id, 'code', cp.code_normalised, 'isPublic', cp.is_public, 'status', cp.status,
               'redeemed', COALESCE(s.n, 0),
               'discountGivenPaise', COALESCE(s.given, 0)::text)
             ORDER BY cp.id DESC)
        FROM core.coupon cp LEFT JOIN seen s ON s.coupon_id = cp.id
       WHERE cp.company_id = (SELECT id FROM co) AND cp.scope = 'MERCHANT'), '[]'::jsonb),
    'activeCount', (SELECT count(*) FROM core.coupon cp WHERE cp.company_id = (SELECT id FROM co) AND cp.status = 'ACTIVE'),
    'activeMax', core.config_int(core.current_config_id(), ARRAY['coupon_active_per_company_max'], 5),
    'hasCompany', EXISTS (SELECT 1 FROM co))
$$;

REVOKE SELECT ON core.product FROM app_web, app_pay;
GRANT SELECT (id, company_id, seller_type, status, current_version_id, category, inventory_mode, exclusive_supply,
              offers_express, free_standard_delivery, zap_flag, published_at, planned_quantity, pending_version_id,
              approved_needs_stock, moderation_reason, created_at, updated_at)
  ON core.product TO app_web, app_pay;

REVOKE SELECT ON core.warehouse FROM app_web, app_pay;
GRANT SELECT (id, company_id, kind, capacity, zap_hub) ON core.warehouse TO app_web, app_pay;

REVOKE SELECT ON core.coupon FROM app_web, app_pay;
GRANT SELECT (id, scope, company_id, campaign_id, code_normalised, kind, value, min_spend_paise, starts_at, ends_at,
              max_redemptions, is_public, status, code_generated)
  ON core.coupon TO app_web, app_pay;

REVOKE SELECT (state) ON core.inventory_unit FROM app_web, app_pay;
