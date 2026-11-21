-- Row lifecycle guards (fourth security review). Enforced by trigger for EVERY role, the owner
-- included, so that they hold whatever privileges a role is (wrongly) given.

-- ---------------------------------------------------------------- inventory unit state machine
-- A unit is stocked AVAILABLE and then moves only
--   AVAILABLE -> ISSUED          (sold, inside core.commit_purchase; R4 of 0016 checks the line)
--   AVAILABLE -> RETIRED_UNSOLD  (taken off sale)
--   ISSUED    -> REVOKED_ISSUED  (a reversed sale; the unit is not resold)
-- and never back to AVAILABLE: a sold unit put back on sale would be sold twice. Its product and
-- serial never change; its order line is set only when it is issued; it changes warehouse only
-- while it stays AVAILABLE.
CREATE FUNCTION core.guard_inventory_unit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'AVAILABLE' OR NEW.order_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'inventory unit % is stocked AVAILABLE, without an order line', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND (OLD.state, NEW.state) NOT IN (('AVAILABLE', 'ISSUED'), ('AVAILABLE', 'RETIRED_UNSOLD'),
                                        ('ISSUED', 'REVOKED_ISSUED')) THEN
    RAISE EXCEPTION 'inventory unit % may move only AVAILABLE->ISSUED, AVAILABLE->RETIRED_UNSOLD or ISSUED->REVOKED_ISSUED (not % -> %)',
      OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.product_id, NEW.serial) IS DISTINCT FROM (OLD.id, OLD.product_id, OLD.serial) THEN
    RAISE EXCEPTION 'inventory unit %: its id, product and serial never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.order_line_id IS DISTINCT FROM OLD.order_line_id
     AND NOT (OLD.state = 'AVAILABLE' AND NEW.state = 'ISSUED' AND OLD.order_line_id IS NULL) THEN
    RAISE EXCEPTION 'inventory unit %: its order line is set once, when it is issued', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id AND NOT (OLD.state = 'AVAILABLE' AND NEW.state = 'AVAILABLE') THEN
    RAISE EXCEPTION 'inventory unit %: only an AVAILABLE unit moves between warehouses', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_lifecycle BEFORE INSERT OR UPDATE ON core.inventory_unit
  FOR EACH ROW EXECUTE FUNCTION core.guard_inventory_unit();

REVOKE ALL ON FUNCTION core.guard_inventory_unit() FROM PUBLIC;

-- ---------------------------------------------------------------- records that are never deleted
-- Ownership, orders, order lines, shipments, coupon redemptions, grant records, inventory units
-- and the seals of 0016 are records of money, ownership and stock: a deleted redemption lets a
-- coupon be reused, a deleted ownership or unit lets a product be sold again, a deleted seal
-- reopens a checked purchase. No role deletes or truncates them, the owner included.
-- Account deletion will get its own owner-run definer function, which will anonymise these
-- records rather than delete them (and will lift this guard only for what it must remove).
CREATE FUNCTION core.refuse_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '%.% rows are never deleted (records of money, ownership, orders and stock)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'core.ownership', 'core.order_group', 'core.seller_order', 'core.order_line', 'core.shipment',
    'core.coupon_redemption', 'core.inventory_unit', 'core.order_group_seal',
    'ledger.grant_record', 'ledger.journal_seal'
  ] LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.refuse_delete()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION core.refuse_delete()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- counters move only with their rows
-- The deferred counter check of 0016 compares the counters with the rows they count at commit;
-- these guards refuse an inconsistent counter at the statement that writes it, for every role.
--  * coupon.redeemed never decreases (a redemption is never deleted, so its count cannot fall);
--  * product.available_units of stocked products and warehouse.used change only to the number
--    of AVAILABLE units they count at that moment: the unit's state change is written first
--    (core.commit_purchase issues the unit, then moves the counters).
CREATE FUNCTION core.guard_counters() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  IF TG_TABLE_NAME = 'coupon' THEN
    IF NEW.redeemed < OLD.redeemed THEN
      RAISE EXCEPTION 'coupon %: redeemed never decreases (% -> %)', OLD.id, OLD.redeemed, NEW.redeemed
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'product' THEN
    IF NEW.available_units IS DISTINCT FROM OLD.available_units
       AND NEW.inventory_mode IN ('STANDARD_STOCKED', 'EXCLUSIVE') THEN
      SELECT count(*) INTO n FROM core.inventory_unit u WHERE u.product_id = NEW.id AND u.state = 'AVAILABLE';
      IF NEW.available_units <> n THEN
        RAISE EXCEPTION 'product %: available_units may change only to its % AVAILABLE units (not %)',
          NEW.id, n, NEW.available_units USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW.used IS DISTINCT FROM OLD.used THEN
      SELECT count(*) INTO n FROM core.inventory_unit u WHERE u.warehouse_id = NEW.id AND u.state = 'AVAILABLE';
      IF NEW.used <> n THEN
        RAISE EXCEPTION 'warehouse %: used may change only to its % AVAILABLE units (not %)', NEW.id, n, NEW.used
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_counters BEFORE UPDATE ON core.coupon
  FOR EACH ROW EXECUTE FUNCTION core.guard_counters();
CREATE TRIGGER guard_counters BEFORE UPDATE ON core.product
  FOR EACH ROW EXECUTE FUNCTION core.guard_counters();
CREATE TRIGGER guard_counters BEFORE UPDATE ON core.warehouse
  FOR EACH ROW EXECUTE FUNCTION core.guard_counters();

REVOKE ALL ON FUNCTION core.refuse_delete(), core.guard_counters() FROM PUBLIC;
