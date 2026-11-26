-- Sale price, part 1: the records (PRD R6.2 "sale price (merchant)", R8 Pricing, US-43).
--
-- A merchant may put a live listing on sale: a lower price than its list price, for as long as it
-- chooses, and end the sale to return to the list price. The sale price IS the listing's live price
-- (a new product version, so every quote, cart, purchase and fee is computed from it by the one
-- pricing function and a price change invalidates outstanding quotes, US-08); what the sale adds is
-- the memory of the list price to return to:
--
--   core.product_sale   one row per sale: the list price the sale started from, the current sale
--                       price, when it started and when it ended (NULL while it lasts). At most
--                       one open sale per product. The row never moves to another product, never
--                       changes its list price or start, and once ended never changes again;
--                       only the sale price of an open sale may be changed (by the owner's
--                       command). Never deleted. No application role reads or writes it: the
--                       owner's commands (0081) are the only writers, the studio read of a listing
--                       (core.my_product) the only reader. It is never joined into a public read.
--
-- The honest reference ("was") price is not stored: core.reference_price (0043) derives it from
-- core.price_history, which now also records why a price changed: SALE_START (list price -> sale
-- price), SALE_CHANGE (a new sale price during a sale) and SALE_END (back to the list price).
-- Sellers learn nothing about buyers or the timing of purchases from either table: neither carries
-- an order, a buyer or a count of sales, and both change only when the owner acts.

ALTER TABLE core.price_history DROP CONSTRAINT price_history_reason_check;
ALTER TABLE core.price_history ADD CONSTRAINT price_history_reason_check
  CHECK (reason IN ('PUBLISHED', 'PRICE_CHANGE', 'REVISION', 'SALE_START', 'SALE_CHANGE', 'SALE_END'));

CREATE TABLE core.product_sale (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  uuid NOT NULL REFERENCES core.product (id),
  list_paise  bigint NOT NULL CHECK (list_paise > 0),
  sale_paise  bigint NOT NULL CHECK (sale_paise > 0),
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at    timestamptz,
  CONSTRAINT product_sale_lower CHECK (sale_paise < list_paise),
  CONSTRAINT product_sale_times CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX product_sale_one_open ON core.product_sale (product_id) WHERE ended_at IS NULL;
CREATE INDEX product_sale_product ON core.product_sale (product_id, id);

ALTER TABLE core.product_sale ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.product_sale FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.product_sale USING (false) WITH CHECK (false);

-- What may change on a sale row, whoever writes: the sale price of an open sale, and the end time
-- once (NULL -> a time). Nothing else, ever.
CREATE FUNCTION core.guard_product_sale() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.list_paise IS DISTINCT FROM OLD.list_paise OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'core.product_sale: a sale''s product, list price and start never change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'core.product_sale: an ended sale never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.guard_product_sale() FROM PUBLIC;

CREATE TRIGGER guard_update BEFORE UPDATE ON core.product_sale
  FOR EACH ROW EXECUTE FUNCTION core.guard_product_sale();
CREATE TRIGGER no_delete BEFORE DELETE ON core.product_sale
  FOR EACH ROW EXECUTE FUNCTION core.refuse_delete();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON core.product_sale
  FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete();
