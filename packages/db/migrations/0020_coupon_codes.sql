-- Coupon codes (fourth security review): guessing a private code must be infeasible.
--
-- The failed-lookup counter of 0018 commits only when the caller commits, so a caller that rolls
-- back guesses unthrottled. Instead of relying on it, a private coupon's code is never chosen: it
-- is 16 symbols drawn uniformly from a 32-symbol alphabet with no look-alikes (0/O, 1/I), i.e.
-- 80 random bits from pgcrypto's gen_random_bytes. A public coupon (listed to everyone anyway)
-- keeps a chosen 4–16 character code.
--
-- core.create_coupon is the ONLY way a coupon is created (app_web holds no INSERT on core.coupon
-- any more, 0011/0012), and core.set_coupon_status the way its owner pauses, resumes or ends it.
-- A trigger requires code_generated (and the generated form) for every non-public coupon, for
-- every role, and keeps a coupon's code, visibility, scope and company fixed.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE core.coupon ADD COLUMN code_generated boolean NOT NULL DEFAULT false;

CREATE FUNCTION core.coupon_code_alphabet() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'::text
$$;

-- 16 symbols, each from one random byte: 256 is a multiple of 32, so every symbol is equally
-- likely. pgcrypto lives wherever the platform installed it (public locally, `extensions` on
-- Supabase): the function is created with that schema named explicitly.
DO $do$
DECLARE
  sch text;
BEGIN
  SELECT n.nspname INTO sch FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pgcrypto';
  EXECUTE format($f$
    CREATE FUNCTION core.generate_coupon_code() RETURNS text
    LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $b$
      SELECT string_agg(substr(core.coupon_code_alphabet(), get_byte(x.b, i) %% 32 + 1, 1), '' ORDER BY i)
        FROM (SELECT %I.gen_random_bytes(16) AS b) x, generate_series(0, 15) i
    $b$
  $f$, sch);
END $do$;

-- ---------------------------------------------------------------- every role
CREATE FUNCTION core.guard_coupon_code() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.scope, NEW.company_id, NEW.code_normalised, NEW.is_public, NEW.code_generated)
       IS DISTINCT FROM (OLD.id, OLD.scope, OLD.company_id, OLD.code_normalised, OLD.is_public, OLD.code_generated) THEN
      RAISE EXCEPTION 'coupon %: its code, visibility, scope and company never change', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT NEW.is_public AND NOT NEW.code_generated THEN
    RAISE EXCEPTION 'a private coupon''s code is generated (core.create_coupon), never chosen'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.code_generated AND NEW.code_normalised !~ ('^[' || core.coupon_code_alphabet() || ']{16}$') THEN
    RAISE EXCEPTION 'a generated coupon code is 16 symbols of the coupon alphabet' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW.code_generated AND NEW.code_normalised !~ '^[A-Z0-9]{4,16}$' THEN
    RAISE EXCEPTION 'a public coupon code is 4–16 letters or digits' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_code BEFORE INSERT OR UPDATE ON core.coupon
  FOR EACH ROW EXECUTE FUNCTION core.guard_coupon_code();

-- ---------------------------------------------------------------- creating a coupon
-- For the signed-in owner of the company (FORBIDDEN otherwise). Limits from the current
-- configuration: `coupon_active_per_company_max` (5) ACTIVE coupons per company (CONFLICT beyond),
-- a PERCENT value within `coupon_percent_min`..`coupon_percent_max` (1..90), a FLAT value above
-- zero. A public coupon takes `public_code` (4–16 letters or digits, normalised to upper case); a
-- private one never takes a code: it always gets a generated one. Returns {couponId, code}.
CREATE FUNCTION core.create_coupon(company_id uuid, kind text, value bigint, min_spend bigint,
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
    PERFORM core.fail('CONFLICT', 'this company already has the most active coupons allowed');
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
CREATE FUNCTION core.set_coupon_status(coupon_id uuid, status text) RETURNS void
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
    PERFORM core.fail('CONFLICT', 'this company already has the most active coupons allowed');
  END IF;
  BEGIN
    UPDATE core.coupon c SET status = set_coupon_status.status WHERE c.id = cp.id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM core.fail('CONFLICT', 'an active coupon of this company already has this code');
  END;
END $$;

REVOKE ALL ON FUNCTION core.coupon_code_alphabet(), core.generate_coupon_code(), core.guard_coupon_code(),
  core.create_coupon(uuid, text, bigint, bigint, timestamptz, timestamptz, int, boolean, text),
  core.set_coupon_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  core.create_coupon(uuid, text, bigint, bigint, timestamptz, timestamptz, int, boolean, text),
  core.set_coupon_status(uuid, text)
TO app_web;
