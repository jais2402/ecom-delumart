-- Buyer de-anonymisation through the seller's order view (sixth security review, minor 8). A private
-- coupon code is generated per buyer or per small group, so returning it to the seller told the
-- seller who bought; and an exact order time can be matched against what a buyer says publicly.
--   * couponCode is returned only for a PUBLIC coupon of this store; for a private one it is null and
--     couponKind is 'PRIVATE' (couponKind 'PUBLIC' with a public code; null without a coupon).
--   * orderedAt and every delivery timeline time are rounded down to the minute.
-- Everything else is as in 0042.

CREATE OR REPLACE FUNCTION core.seller_order_json(p_seller_order uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'sellerOrderId', so.id,
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
