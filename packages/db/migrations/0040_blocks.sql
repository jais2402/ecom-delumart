-- Trust and safety, part 2: blocking a store (PRD §7.7; LLD §8.2 "Personal overlay ... blocked",
-- §5.2 "not blocked").
--
--   core.store_block   (user, company): the user blocked the store. Owner-only table: no
--                      application role reads or writes a row; the commands below do.
--   core.block_store(company_id) / core.unblock_store(company_id) / core.my_blocks()
--                      The signed-in user's own blocks only. A store is a registered company with a
--                      handle (NOT_FOUND otherwise); nobody blocks their own store
--                      (VALIDATION_FAILED); at most `store_blocks_max` (500) blocks per account.
--                      The blocked store never learns of it: no read shows a block to anyone but
--                      the user who made it.
--
-- A purchase between the two parties is refused in either direction with the neutral
-- PRODUCT_UNAVAILABLE: the blocker cannot buy from the blocked store, and the owner of the blocked
-- store cannot buy from a store owned by the blocker.
--   * at checkout session creation and cart preview: core.resolve_cart (0018) refuses it;
--   * at pay: a trigger on core.seller_order refuses the row for every writer, inside
--     core.purchase_write's exception block, so core.commit_purchase records the attempt FAILED
--     with PRODUCT_UNAVAILABLE and nothing of the purchase remains.
-- Race: core.block_store takes the rows of the blocked company and of the blocker's own company
-- (LLD §4 #4, ascending id) FOR NO KEY UPDATE, which waits for a purchase in flight that holds
-- either FOR SHARE (core.purchase_write #4); a purchase that locks the company after the block
-- committed sees the block when its seller order row is written.

CREATE TABLE core.store_block (
  user_id    uuid NOT NULL REFERENCES core.user_profile (id),
  company_id uuid NOT NULL REFERENCES core.company (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX store_block_company ON core.store_block (company_id);
ALTER TABLE core.store_block ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.store_block FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.store_block USING (false) WITH CHECK (false);

-- Whether a purchase by `buyer` from `company` is refused by a block, in either direction.
CREATE FUNCTION core.purchase_blocked(p_buyer uuid, p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_company IS NOT NULL AND (
    EXISTS (SELECT 1 FROM core.store_block b WHERE b.user_id = p_buyer AND b.company_id = p_company)
    OR EXISTS (SELECT 1 FROM core.store_block b JOIN core.company bc ON bc.id = b.company_id
                WHERE bc.owner_user_id = p_buyer AND b.user_id = ANY (core.company_party_ids(p_company))))
$$;

-- ---------------------------------------------------------------- pay: every writer
CREATE FUNCTION core.refuse_blocked_purchase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.company_id IS NOT NULL AND core.purchase_blocked(NEW.buyer_user_id, NEW.company_id) THEN
    PERFORM core.fail('PRODUCT_UNAVAILABLE', 'a product is no longer available');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refuse_blocked BEFORE INSERT ON core.seller_order
  FOR EACH ROW EXECUTE FUNCTION core.refuse_blocked_purchase();

-- ---------------------------------------------------------------- checkout: 0018's resolution, then the blocks
ALTER FUNCTION core.resolve_cart(uuid, jsonb) RENAME TO resolve_cart_base;
CREATE FUNCTION core.resolve_cart(actor uuid, choices jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  resolved jsonb := core.resolve_cart_base(actor, choices);
BEGIN
  IF resolved ? 'error' THEN
    RETURN resolved;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(resolved #> '{inputs,lines}') l
              WHERE core.is_uuid(l ->> 'companyId') AND core.purchase_blocked(actor, (l ->> 'companyId')::uuid)) THEN
    RETURN core.err('PRODUCT_UNAVAILABLE', 'a product is not available');
  END IF;
  RETURN resolved;
END $$;

-- ---------------------------------------------------------------- commands
CREATE FUNCTION core.my_blocks() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('items', COALESCE(jsonb_agg(jsonb_build_object(
           'companyId', c.id, 'handle', c.handle, 'displayName', c.name, 'blockedAt', b.created_at)
           ORDER BY b.created_at DESC, c.id), '[]'::jsonb))
    FROM core.store_block b JOIN core.company c ON c.id = b.company_id
   WHERE b.user_id = core.require_actor()
$$;

CREATE FUNCTION core.block_store(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor uuid := core.require_actor();
BEGIN
  PERFORM ledger.require_read_committed();
  IF NOT EXISTS (SELECT 1 FROM core.user_profile up WHERE up.id = v_actor) THEN
    PERFORM core.fail('ONBOARDING_REQUIRED', 'finish onboarding first');
  END IF;
  IF p_company IS NULL OR NOT EXISTS (SELECT 1 FROM core.company c WHERE c.id = p_company AND c.handle IS NOT NULL) THEN
    PERFORM core.fail('NOT_FOUND', 'store not found');
  END IF;
  IF v_actor = ANY (core.company_party_ids(p_company)) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'you cannot block your own store');
  END IF;
  PERFORM core.lock_actor('core.store_block', v_actor);
  IF NOT EXISTS (SELECT 1 FROM core.store_block b WHERE b.user_id = v_actor AND b.company_id = p_company)
     AND (SELECT count(*) FROM core.store_block b WHERE b.user_id = v_actor)
         >= core.config_int(core.current_config_id(), ARRAY['store_blocks_max'], 500) THEN
    PERFORM core.fail('CONFLICT', 'you have blocked as many stores as you may; unblock one first');
  END IF;
  -- #4 the two companies, ascending id: purchases between them in flight finish first
  PERFORM 1 FROM core.company c
   WHERE c.id = p_company OR c.owner_user_id = v_actor
   ORDER BY c.id FOR NO KEY UPDATE;
  INSERT INTO core.store_block (user_id, company_id) VALUES (v_actor, p_company) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('companyId', p_company, 'blocked', true);
END $$;

CREATE FUNCTION core.unblock_store(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_actor uuid := core.require_actor();
BEGIN
  DELETE FROM core.store_block b WHERE b.user_id = v_actor AND b.company_id = p_company;
  RETURN jsonb_build_object('companyId', p_company, 'blocked', false);
END $$;

REVOKE ALL ON FUNCTION core.purchase_blocked(uuid, uuid), core.refuse_blocked_purchase(), core.resolve_cart(uuid, jsonb),
  core.my_blocks(), core.block_store(uuid), core.unblock_store(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.my_blocks(), core.block_store(uuid), core.unblock_store(uuid) TO app_web;
