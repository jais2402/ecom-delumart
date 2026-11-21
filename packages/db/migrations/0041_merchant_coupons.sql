-- Merchant coupons over HTTP (US-41): the owner's coupon list and a store's public coupons.
--
--   core.create_coupon / core.set_coupon_status (0020) are unchanged except that the limit of
--   `coupon_active_per_company_max` (5) ACTIVE coupons per company now refuses with its own stable
--   code, COUPON_LIMIT (it was CONFLICT, which still means a duplicate active code or an ended
--   coupon made active again). The limit is counted under the company's coupon lock, so
--   concurrent creations and resumptions cannot overrun it.
--   core.my_coupons() -> the signed-in owner's coupons (their company only): kind, value, minimum
--     spend, window, cap, redeemed count, discount given in total, public flag, status and the
--     code. A private coupon's generated code is shown to its company's owner only (here), never
--     listed anywhere else.
--   core.store_coupons(handle) -> a store's PUBLIC coupons that can be used now (ACTIVE, inside
--     their window, below their cap): code and terms. Public data, no actor needed.
-- Who cannot redeem: the company's owner (core.coupon_problem, 0018: COUPON_NOT_APPLICABLE, and
-- SELF_PURCHASE), and a buyer on either side of a block (0040: no purchase between them at all,
-- PRODUCT_UNAVAILABLE).

CREATE OR REPLACE FUNCTION core.create_coupon(company_id uuid, kind text, value bigint, min_spend bigint,
                                   starts_at timestamptz, ends_at timestamptz, max_redemptions int,
                                   is_public boolean, public_code text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  cfg   int := core.current_config_id();
  cid   uuid := core.uuid_v7();
  code  text;
  tries int := 0;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF create_coupon.company_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM core.company c WHERE c.id = create_coupon.company_id AND c.owner_user_id = actor) THEN
    PERFORM core.fail('FORBIDDEN', 'only the company''s owner creates its coupons');
  END IF;
  IF create_coupon.kind IS NULL OR create_coupon.kind NOT IN ('PERCENT', 'FLAT') OR create_coupon.value IS NULL
     OR (create_coupon.kind = 'PERCENT'
         AND create_coupon.value NOT BETWEEN core.config_int(cfg, ARRAY['coupon_percent_min'], 1)
                                         AND core.config_int(cfg, ARRAY['coupon_percent_max'], 90))
     OR (create_coupon.kind = 'FLAT' AND create_coupon.value <= 0) THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a coupon is PERCENT (within the allowed range) or FLAT (above zero)');
  END IF;
  IF COALESCE(create_coupon.min_spend, 0) < 0 OR create_coupon.max_redemptions <= 0
     OR create_coupon.ends_at <= clock_timestamp() OR create_coupon.ends_at <= create_coupon.starts_at
     OR create_coupon.is_public IS NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'coupon terms are not valid');
  END IF;
  IF create_coupon.is_public THEN
    code := upper(btrim(create_coupon.public_code));
    IF code IS NULL OR code !~ '^[A-Z0-9]{4,16}$' THEN
      PERFORM core.fail('VALIDATION_FAILED', 'a public coupon code is 4–16 letters or digits');
    END IF;
  ELSIF create_coupon.public_code IS NOT NULL THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a private coupon''s code is generated, never chosen');
  END IF;

  -- one company's coupon creations run one at a time, so the active count cannot be overrun
  PERFORM core.lock_actor('core.coupon', create_coupon.company_id);
  IF (SELECT count(*) FROM core.coupon c WHERE c.company_id = create_coupon.company_id AND c.status = 'ACTIVE')
     >= core.config_int(cfg, ARRAY['coupon_active_per_company_max'], 5) THEN
    PERFORM core.fail('COUPON_LIMIT', 'this company already has the most active coupons allowed');
  END IF;

  LOOP
    IF NOT create_coupon.is_public THEN
      code := core.generate_coupon_code();
    END IF;
    BEGIN
      INSERT INTO core.coupon (id, scope, company_id, code_normalised, code_generated, kind, value, min_spend_paise,
                               starts_at, ends_at, max_redemptions, is_public, status)
      VALUES (cid, 'MERCHANT', create_coupon.company_id, code, NOT create_coupon.is_public, create_coupon.kind,
              create_coupon.value, COALESCE(create_coupon.min_spend, 0), create_coupon.starts_at, create_coupon.ends_at,
              create_coupon.max_redemptions, create_coupon.is_public, 'ACTIVE');
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      tries := tries + 1;
      IF create_coupon.is_public OR tries >= 5 THEN
        PERFORM core.fail('CONFLICT', 'an active coupon of this company already has this code');
      END IF;
    END;
  END LOOP;
  RETURN jsonb_build_object('couponId', cid, 'code', code);
END $$;

-- ---------------------------------------------------------------- pausing, resuming, ending
-- For the signed-in owner of the coupon's company. ACTIVE <-> PAUSED; ACTIVE or PAUSED -> ENDED;
-- any -> ARCHIVED; ENDED and ARCHIVED never become ACTIVE again (CONFLICT). Resuming counts
-- against the active-coupon limit. The coupon row is locked like core.commit_purchase locks it
-- (LLD §4 #2), so a purchase in flight finishes on the terms it read.
CREATE OR REPLACE FUNCTION core.set_coupon_status(coupon_id uuid, status text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
  cp    record;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF set_coupon_status.status IS NULL OR set_coupon_status.status NOT IN ('ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED') THEN
    PERFORM core.fail('VALIDATION_FAILED', 'unknown coupon status');
  END IF;
  SELECT c.id, c.company_id, c.status INTO cp FROM core.coupon c
   WHERE c.id = set_coupon_status.coupon_id AND c.scope = 'MERCHANT'
     AND EXISTS (SELECT 1 FROM core.company co WHERE co.id = c.company_id AND co.owner_user_id = actor);
  IF NOT FOUND THEN
    PERFORM core.fail('FORBIDDEN', 'only the company''s owner changes its coupons');
  END IF;
  IF set_coupon_status.status = 'ACTIVE' THEN
    PERFORM core.lock_actor('core.coupon', cp.company_id);
  END IF;
  SELECT c.id, c.company_id, c.status INTO cp FROM core.coupon c WHERE c.id = cp.id FOR NO KEY UPDATE;
  IF cp.status = set_coupon_status.status THEN
    RETURN;
  END IF;
  IF cp.status IN ('ENDED', 'ARCHIVED') AND set_coupon_status.status <> 'ARCHIVED' THEN
    PERFORM core.fail('CONFLICT', 'an ended or archived coupon cannot be used again');
  END IF;
  IF set_coupon_status.status = 'ACTIVE'
     AND (SELECT count(*) FROM core.coupon c WHERE c.company_id = cp.company_id AND c.status = 'ACTIVE')
         >= core.config_int(core.current_config_id(), ARRAY['coupon_active_per_company_max'], 5) THEN
    PERFORM core.fail('COUPON_LIMIT', 'this company already has the most active coupons allowed');
  END IF;
  BEGIN
    UPDATE core.coupon c SET status = set_coupon_status.status WHERE c.id = cp.id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM core.fail('CONFLICT', 'an active coupon of this company already has this code');
  END;
END $$;

CREATE FUNCTION core.coupon_terms_json(c core.coupon) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'kind', c.kind,
    'percent', CASE WHEN c.kind = 'PERCENT' THEN c.value END,
    'amountPaise', CASE WHEN c.kind = 'FLAT' THEN c.value::text END,
    'minSpendPaise', c.min_spend_paise::text,
    'startsAt', c.starts_at, 'endsAt', c.ends_at, 'maxRedemptions', c.max_redemptions)
$$;

CREATE FUNCTION core.my_coupons() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH co AS (SELECT c.id FROM core.company c WHERE c.owner_user_id = core.require_actor())
  SELECT jsonb_build_object(
    'items', COALESCE((
      SELECT jsonb_agg(core.coupon_terms_json(cp) || jsonb_build_object(
               'couponId', cp.id, 'code', cp.code_normalised, 'isPublic', cp.is_public, 'status', cp.status,
               'redeemed', cp.redeemed,
               'discountGivenPaise', (SELECT COALESCE(SUM(r.discount_paise), 0)::text
                                        FROM core.coupon_redemption r WHERE r.coupon_id = cp.id))
             ORDER BY cp.id DESC)
        FROM core.coupon cp WHERE cp.company_id = (SELECT id FROM co) AND cp.scope = 'MERCHANT'), '[]'::jsonb),
    'activeCount', (SELECT count(*) FROM core.coupon cp WHERE cp.company_id = (SELECT id FROM co) AND cp.status = 'ACTIVE'),
    'activeMax', core.config_int(core.current_config_id(), ARRAY['coupon_active_per_company_max'], 5),
    'hasCompany', EXISTS (SELECT 1 FROM co))
$$;

CREATE FUNCTION core.store_coupons(p_handle text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('items', COALESCE(jsonb_agg(core.coupon_terms_json(cp) || jsonb_build_object('code', cp.code_normalised)
                                                         ORDER BY cp.id), '[]'::jsonb))
    FROM core.company c JOIN core.coupon cp ON cp.company_id = c.id
   WHERE c.handle IS NOT NULL AND lower(c.handle) = lower(p_handle)
     AND cp.scope = 'MERCHANT' AND cp.is_public AND cp.status = 'ACTIVE'
     AND (cp.starts_at IS NULL OR cp.starts_at <= clock_timestamp())
     AND (cp.ends_at IS NULL OR cp.ends_at > clock_timestamp())
     AND (cp.max_redemptions IS NULL OR cp.redeemed < cp.max_redemptions)
$$;

REVOKE ALL ON FUNCTION core.coupon_terms_json(core.coupon), core.my_coupons(), core.store_coupons(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.my_coupons(), core.store_coupons(text) TO app_web;
