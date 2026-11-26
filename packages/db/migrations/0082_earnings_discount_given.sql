-- Finances: discount given beside merchant-funded delivery (PRD R8 Finances, R6.6, US-45).
--
-- core.earnings_totals (0042) reports, per period and source, gross (list price after the seller's
-- discount), marketplace fees, merchant-funded delivery and net. R8 adds a discount-given column:
-- the seller-funded (merchant coupon) discount of the same completed orders. Each figure is
-- reported once: gross + discount = the sale prices sold at, net = gross - fees - merchant-funded
-- delivery, equal to what the ledger credited the owner. A sale price is not a discount (the sale
-- price is the list price the order is priced from, R6.6), so it appears in none of these.
--
-- Nothing else changes: the same seller-visibility delay (0060), the same orders, no buyer.

CREATE OR REPLACE FUNCTION core.earnings_totals(p_company uuid, p_source text, p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH o AS (
    SELECT so.id, so.list_paise - so.seller_discount_paise AS gross, so.seller_discount_paise AS discount,
           so.fee_paise, so.delivery_fee_seller_paise, so.buyer_user_id, core.seller_order_credit(so.id) AS net
      FROM core.seller_order so JOIN core.order_group g ON g.id = so.order_group_id
     WHERE so.company_id = p_company AND so.status = 'COMPLETED' AND g.buyer_source = p_source
       AND g.created_at >= p_from AND g.created_at < p_to)
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to,
    'orders', count(*),
    'grossPaise', COALESCE(SUM(o.gross), 0)::text,
    'discountPaise', COALESCE(SUM(o.discount), 0)::text,
    'feesPaise', COALESCE(SUM(o.fee_paise), 0)::text,
    'merchantDeliveryPaise', COALESCE(SUM(o.delivery_fee_seller_paise), 0)::text,
    'netPaise', COALESCE(SUM(o.net), 0)::text,
    'distinctBuyers', count(DISTINCT o.buyer_user_id),
    'averageOrderPaise', CASE WHEN count(*) > 0 THEN div(SUM(o.gross), count(*))::text END)
    FROM o
$$;
