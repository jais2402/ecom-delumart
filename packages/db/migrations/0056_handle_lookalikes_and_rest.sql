-- Handles and public codes (seventh security review, minors 4, 5a and 7a).
--
-- 4. Look-alike handles. core.handle_fold(h, rn_as_m): lower case, hyphens removed, optionally `rn`
--    read as `m`, then 0→o, 1/i/l→l, 3→e, 4→a, 5→s, 7→t, 8→b, and runs of one character collapsed
--    to one. A handle is a look-alike (core.handle_lookalike) when, under either reading of `rn`,
--      * a PROTECTED word (core.handle_protected_words(): the brand and authority words) appears
--        anywhere in its folded form (core.handle_protected_lookalike), or
--      * its folded form, without any number of its leading and trailing digits, is a GENERIC word
--        (core.handle_generic_words(): shop, store, pay, api, root, help, www, ...).
--    So `delulurnart`, `adrnin`, `admin1`, `deluluofficial`, `dellulumart` are refused and
--    `cake-shop`, `acme-store`, `root-beer`, `pay-day`, `api-studio` are accepted. Mirrors
--    validateHandle in packages/core (a shared test table keeps them in agreement).
--      * Store handles: core.store_handle_lookalike is now core.handle_lookalike (quote and
--        registration refuse HANDLE_TAKEN). The 0049 CHECK (NOT VALID) is replaced by a trigger on
--        INSERT or UPDATE OF handle (any writer, check_violation), so a store registered under
--        the earlier rules keeps working (its handle never changes).
--      * User handles: core.update_profile now refuses a look-alike as CONFLICT (as a reserved one).
-- 5a. Public coupon codes stay 4–16 of A–Z and 0–9 and may not contain a protected word in any
--    spelling (VALIDATION_FAILED); the route also screens the code (and a user handle) with
--    screenText. Together with the strict charsets this keeps app_web from storing unscreened
--    public text through these two commands.
-- 7a. Handle squatting by colluders taking turns. A "hold" is one person's reservation of a handle
--    (re-quotes within it keep its expiry and are the same hold). When the two most recent holds
--    of a handle both ended unpaid, both within `handle_lapse_window_hours` (24), the handle rests
--    for `handle_lapse_cooldown_minutes` (30) after the second lapse: nobody may reserve it
--    (HANDLE_RESERVED). The per-person cooldown of 0049 stays.

-- ---------------------------------------------------------------- 4. look-alikes
CREATE FUNCTION core.handle_protected_words() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['delulu', 'delulumart', 'admin', 'administrator', 'superadmin', 'official', 'support', 'staff',
               'moderator', 'security', 'verified', 'system']
$$;

CREATE FUNCTION core.handle_generic_words() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['help', 'root', 'bank', 'pay', 'originals', 'store', 'shop', 'www', 'api', 'account', 'cart',
               'checkout', 'orders', 'console', 'partner']
$$;

CREATE FUNCTION core.handle_fold(h text, rn_as_m boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT regexp_replace(
           translate(CASE WHEN rn_as_m THEN replace(replace(lower(h), '-', ''), 'rn', 'm')
                          ELSE replace(lower(h), '-', '') END,
                     '0134578i', 'oleastbl'),
           '(.)\1+', '\1', 'g')
$$;

CREATE FUNCTION core.handle_protected_lookalike(h text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT h IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(ARRAY[true, false]) rn, unnest(core.handle_protected_words()) w
     WHERE strpos(core.handle_fold(h, rn), core.handle_fold(w, rn)) > 0)
$$;

CREATE FUNCTION core.handle_lookalike(h text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT h IS NOT NULL AND (
    core.handle_protected_lookalike(h)
    OR EXISTS (
      SELECT 1
        FROM (SELECT char_length(substring(h FROM '^[0-9-]*')) AS lead,
                     char_length(substring(h FROM '[0-9-]*$')) AS trail) e,
             generate_series(0, e.lead) i, generate_series(0, e.trail) j,
             unnest(ARRAY[true, false]) rn, unnest(core.handle_generic_words()) w
       WHERE i + j <= char_length(h)
         AND core.handle_fold(substr(h, i + 1, GREATEST(char_length(h) - i - j, 0)), rn) = core.handle_fold(w, rn)))
$$;

CREATE OR REPLACE FUNCTION core.store_handle_lookalike(h text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.handle_lookalike(h)
$$;

ALTER TABLE core.company DROP CONSTRAINT company_handle_not_lookalike;

CREATE FUNCTION core.refuse_lookalike_handle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.handle IS NOT NULL AND core.handle_lookalike(NEW.handle) THEN
    RAISE EXCEPTION 'company handle: % imitates a reserved name', NEW.handle USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER handle_not_lookalike BEFORE INSERT OR UPDATE OF handle ON core.company
  FOR EACH ROW EXECUTE FUNCTION core.refuse_lookalike_handle();

-- user handles
CREATE OR REPLACE FUNCTION core.update_profile(handle text, privacy jsonb, research_opt_out boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.actor_id();
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF update_profile.handle IS NOT NULL AND update_profile.handle !~ '^[a-z0-9-]{3,24}$' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'a handle is 3-24 lowercase letters, digits or hyphens');
  END IF;
  IF update_profile.privacy IS NOT NULL AND (
       jsonb_typeof(update_profile.privacy) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_each(update_profile.privacy) e
                   WHERE e.key <> ALL (core.privacy_keys()) OR jsonb_typeof(e.value) <> 'boolean')) THEN
    PERFORM core.fail('VALIDATION_FAILED',
      'privacy settings are public_shelf, show_collector_level and show_handle_on_purchases, each true or false');
  END IF;
  PERFORM 1 FROM core.user_profile u WHERE u.id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('NOT_FOUND', 'finish onboarding first');
  END IF;
  IF update_profile.handle IS NOT NULL THEN
    IF update_profile.handle = ANY (core.reserved_handles())
       OR core.handle_lookalike(update_profile.handle)
       OR EXISTS (SELECT 1 FROM core.user_profile u
                   WHERE lower(u.handle) = lower(update_profile.handle) AND u.id <> actor) THEN
      PERFORM core.fail('CONFLICT', 'this handle is not available');
    END IF;
  END IF;
  BEGIN
    UPDATE core.user_profile u
       SET handle = COALESCE(update_profile.handle, u.handle),
           privacy = CASE WHEN update_profile.privacy IS NULL THEN u.privacy ELSE u.privacy || update_profile.privacy END,
           research_opt_out = COALESCE(update_profile.research_opt_out, u.research_opt_out)
     WHERE u.id = actor;
  EXCEPTION WHEN unique_violation THEN
    PERFORM core.fail('CONFLICT', 'this handle is not available');   -- taken concurrently
  END;
  RETURN core.own_profile_json(actor);
END $$;

-- ---------------------------------------------------------------- 5a. public coupon codes
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
    -- seventh review (5a): public text; no brand or authority word in any spelling
    IF core.handle_protected_lookalike(lower(code)) THEN
      PERFORM core.fail('VALIDATION_FAILED', 'this coupon code is not available');
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

-- ---------------------------------------------------------------- 7a. resting handles
-- Whether the handle's two most recent holds both lapsed unpaid within the window, the later one
-- less than the cooldown ago. A hold is one person's reservation chain (same expiry); it lapsed
-- when every reservation of it has ended and none was paid.
CREATE FUNCTION core.handle_resting(h text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH cfg AS (
    SELECT make_interval(hours => core.config_int(core.current_config_id(), ARRAY['handle_lapse_window_hours'], 24)::int) AS win,
           make_interval(mins => core.config_int(core.current_config_id(), ARRAY['handle_lapse_cooldown_minutes'], 30)::int) AS rest),
  holds AS (
    SELECT r.user_id, r.expires_at,
           max(LEAST(r.expires_at, COALESCE(r.released_at, r.expires_at))) AS ended_at,
           bool_or(cs.state = 'SUCCEEDED') AS paid,
           bool_or(r.released_at IS NULL AND cs.state = 'OPEN' AND r.expires_at > clock_timestamp()
                   AND cs.expires_at > clock_timestamp()) AS live
      FROM core.handle_reservation r JOIN core.checkout_session cs ON cs.id = r.session_id
     WHERE r.handle = h
     GROUP BY r.user_id, r.expires_at),
  last2 AS (SELECT * FROM holds ORDER BY ended_at DESC LIMIT 2)
  SELECT count(*) = 2
         AND bool_and(NOT paid AND NOT live AND ended_at <= clock_timestamp())
         AND min(ended_at) > clock_timestamp() - (SELECT win FROM cfg)
         AND max(ended_at) > clock_timestamp() - (SELECT rest FROM cfg)
    FROM last2
$$;

CREATE OR REPLACE FUNCTION core.company_quote(handle text, display_name text, description text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor   uuid := core.progression_actor();
  h       text := company_quote.handle;
  n       text := btrim(company_quote.display_name);
  d       text := btrim(COALESCE(company_quote.description, ''));
  problem text[];
  cfg     int := core.current_config_id();
  fee     bigint;
  balance bigint;
  sponsor bigint;
  payable bigint;
  sid     uuid := core.uuid_v7();
  expires timestamptz;
  kept    timestamptz;
  quote   jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.creator_entitlement ce WHERE ce.user_id = actor) THEN
    PERFORM core.fail('CREATOR_LOCKED', 'unlock creator access first');
  END IF;
  IF EXISTS (SELECT 1 FROM core.company c WHERE c.owner_user_id = actor) THEN
    PERFORM core.fail('COMPANY_EXISTS', 'you already have a company');
  END IF;
  problem := COALESCE(core.store_handle_problem(h), core.store_text_problem(n, d));
  IF problem IS NOT NULL THEN
    PERFORM core.fail(problem[1], problem[2]);
  END IF;
  -- quotes per person per hour (counted under the actor's progression lock)
  IF (SELECT count(*) FROM core.checkout_session cs
       WHERE cs.user_id = actor AND cs.type = 'COMPANY_REGISTRATION' AND cs.created_at > clock_timestamp() - interval '1 hour')
     >= core.config_int(cfg, ARRAY['company_quotes_per_hour'], 5) THEN
    PERFORM core.fail('RATE_LIMITED', 'you have asked for as many registration quotes as you may this hour');
  END IF;
  -- the handle's reservation lock: one quote or registration of this handle at a time
  PERFORM core.lock_actor('core.handle_reservation', core.handle_lock_key(h));
  IF EXISTS (SELECT 1 FROM core.company c WHERE lower(c.handle) = lower(h)) THEN
    PERFORM core.fail('HANDLE_TAKEN', 'this handle is not available');
  END IF;
  IF core.handle_reserved_by_other(h, actor) THEN
    PERFORM core.fail('HANDLE_RESERVED', 'this handle is being registered by someone else; try again later');
  END IF;
  -- the actor's own live reservation of this handle keeps its expiry (never extended)
  SELECT min(r.expires_at) INTO kept
    FROM core.handle_reservation r JOIN core.checkout_session cs ON cs.id = r.session_id
   WHERE r.user_id = actor AND r.handle = h AND r.released_at IS NULL AND cs.state = 'OPEN'
     AND r.expires_at > clock_timestamp() AND cs.expires_at > clock_timestamp();
  -- a reservation of theirs that ended unpaid holds this handle back from them for a while
  IF kept IS NULL AND EXISTS (
       SELECT 1 FROM core.handle_reservation r JOIN core.checkout_session cs ON cs.id = r.session_id
        WHERE r.user_id = actor AND r.handle = h AND cs.state <> 'SUCCEEDED'
          AND LEAST(r.expires_at, COALESCE(r.released_at, r.expires_at)) <= clock_timestamp()
          AND LEAST(r.expires_at, COALESCE(r.released_at, r.expires_at))
                > clock_timestamp() - make_interval(mins => core.config_int(cfg, ARRAY['handle_requote_cooldown_minutes'], 30)::int)) THEN
    PERFORM core.fail('HANDLE_RESERVED', 'your earlier hold on this handle lapsed; try again later');
  END IF;
  -- seventh review (7a): a handle whose last two holds lapsed unpaid within a day rests, for everyone
  IF kept IS NULL AND core.handle_resting(h) THEN
    PERFORM core.fail('HANDLE_RESERVED', 'this handle is resting after unpaid holds; try again later');
  END IF;
  -- the actor's earlier quotes end: their reservations are released
  UPDATE core.handle_reservation r SET released_at = clock_timestamp()
   WHERE r.user_id = actor AND r.released_at IS NULL
     AND r.session_id IN (SELECT cs.id FROM core.checkout_session cs
                           WHERE cs.user_id = actor AND cs.type = 'COMPANY_REGISTRATION' AND cs.state = 'OPEN');
  UPDATE core.checkout_session cs SET state = 'EXPIRED'
   WHERE cs.user_id = actor AND cs.type = 'COMPANY_REGISTRATION' AND cs.state = 'OPEN';

  fee := core.config_paise(cfg, ARRAY['company_registration_fee_paise'], 50000000);
  SELECT w.available_paise INTO balance FROM ledger.ledger_account la JOIN ledger.wallet w ON w.account_id = la.id
   WHERE la.user_id = actor AND la.type = 'USER';
  sponsor := core.sponsorship_for(actor, balance, fee);
  payable := fee - sponsor;
  quote := jsonb_build_object('version', 1, 'kind', 'COMPANY_REGISTRATION', 'handle', h, 'displayName', n,
                              'description', d, 'feePaise', fee::text, 'configVersion', cfg);
  INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
  VALUES (sid, actor, 'COMPANY_REGISTRATION', quote, fee, cfg,
          COALESCE(kept, clock_timestamp() + make_interval(secs => core.config_int(cfg, ARRAY['company_quote_ttl_seconds'], 300))))
  RETURNING expires_at INTO expires;
  INSERT INTO core.handle_reservation (session_id, user_id, handle, expires_at) VALUES (sid, actor, h, expires);
  RETURN jsonb_build_object(
    'sessionId', sid, 'expiresAt', expires, 'handle', h, 'displayName', n, 'description', d,
    'feePaise', fee::text, 'sponsorshipPaise', sponsor::text, 'payablePaise', payable::text,
    'balancePaise', balance::text,
    'balanceAfterPaise', CASE WHEN balance >= payable THEN (balance - payable)::text END,
    'sufficient', balance >= payable);
END $$;

REVOKE ALL ON FUNCTION core.handle_protected_words(), core.handle_generic_words(), core.handle_fold(text, boolean),
  core.handle_protected_lookalike(text), core.handle_lookalike(text), core.refuse_lookalike_handle(),
  core.handle_resting(text)
FROM PUBLIC;
