-- Ninth security review, major 1: a phone number recorded without proof no longer blocks its real
-- owner, and squatting a number at the sign-in service has an expiry and a release.
--
-- PROFILE CLAIMS (core.record_phone_verified, replaced here with the same signature):
--   * a number recorded UNVERIFIED ('unverified' mode, 0070: phone_verified = false) does not block
--     another account from later CONFIRMING it by SMS ('sms' mode): the confirmed claim wins, the
--     unverified holder's phone fingerprint is cleared and their profile is flagged
--     phone_reverify_required (they are asked for a number again; nothing else about the account
--     changes, no money moves);
--   * two UNVERIFIED claims of one number: still one account per number, the first claim wins,
--     but it lapses when the holder's account has not completed onboarding (provisioned) within
--     `phone_unverified_claim_hours` (24) of recording it; the next claim then takes the number
--     and the lapsed holder is flagged as above. Why: one account per number is what limits
--     starting-grant farming in 'unverified' mode, and a squatter who never finishes onboarding
--     can hold someone else's number for a day at most. A holder who completed onboarding keeps
--     it (an established account is not taken over by an unproven claim);
--   * a CONFIRMED holder is never touched: CONFLICT, as before (US-49).
--   Profile rows are locked in ascending id order (LLD §4: ascending id within a class).
--
-- STATUS (core.onboarding_status / onboarding_status_of): 'phoneVerified' is now true only for a
-- number confirmed by SMS (or by the trusted local stand-in); a number recorded unverified reports
-- false. 'phoneRecorded' says the phone step is done; 'phoneReverifyRequired' says the account's
-- unverified number was released and a new one is needed.
--
-- SMS-MODE BOOKKEEPING (the web server calls these; the sign-in service's own phone state stays
-- in auth.users):
--   core.phone_attempt   distinct numbers each account asked a code for: at most
--                        `phone_numbers_per_day` (3) new ones per 24 hours and, until the account
--                        completes onboarding, `phone_numbers_lifetime` (5) in all;
--   core.phone_hold      the unconfirmed number the server last set on the account's sign-in user
--                        (keyed fingerprint and time). Holds older than
--                        `phone_code_lifetime_seconds` (600, match Supabase's SMS OTP expiry) are
--                        released by the job runner through the Auth admin API;
--   core.auth_phone_holder(phone, fp)  for a number the sign-in service refused as taken: the
--                        holder's user id, ONLY when the holder's number is unconfirmed and older
--                        than the code lifetime (otherwise NULL). Server-only (app_web, signed-in
--                        caller); never returned to a client. A confirmed holder is never named.
--                        The number is compared, never stored or logged by the function.

ALTER TABLE core.user_profile ADD COLUMN phone_reverify_required boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- tunables (config, with defaults)
CREATE FUNCTION core.phone_setting(p_key text, p_default int) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.config_int(core.current_config_id(), ARRAY[p_key], p_default)::int
$$;

-- ---------------------------------------------------------------- release of an unverified claim
CREATE FUNCTION core.phone_claim_release(p_holder uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE core.user_profile p
     SET phone_fingerprint = NULL, phone_verified_at = NULL, phone_reverify_required = true
   WHERE p.id = p_holder AND p.phone_verified IS FALSE;
END $$;

-- ---------------------------------------------------------------- status
CREATE OR REPLACE FUNCTION core.onboarding_status_of(actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object(
    'hasProfile', u.id IS NOT NULL,
    'phoneRecorded', COALESCE(u.phone_verified_at IS NOT NULL AND u.phone_fingerprint IS NOT NULL, false),
    'phoneVerified', COALESCE(u.phone_verified_at IS NOT NULL AND u.phone_fingerprint IS NOT NULL
                              AND u.phone_verified IS TRUE, false),
    'phoneReverifyRequired', COALESCE(u.phone_reverify_required, false),
    'hasBirthdate', EXISTS (SELECT 1 FROM private.user_secret s WHERE s.user_id = actor),
    'isAdult', COALESCE(u.is_adult, false),
    'provisioned', COALESCE(u.provisioned_at IS NOT NULL, false),
    'pinSet', EXISTS (SELECT 1 FROM core.virtual_card vc
                       WHERE vc.user_id = actor AND vc.status IN ('ACTIVE', 'FROZEN') AND vc.pin_hash IS NOT NULL))
    FROM (SELECT actor AS id) a LEFT JOIN core.user_profile u ON u.id = a.id
$$;

DROP FUNCTION core.onboarding_status();
CREATE FUNCTION core.onboarding_status()
RETURNS TABLE (has_profile boolean, phone_verified boolean, has_birthdate boolean, is_adult boolean,
               provisioned boolean, pin_set boolean, phone_recorded boolean, phone_reverify_required boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := core.actor_id();
  s     jsonb;
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  s := core.onboarding_status_of(actor);
  RETURN QUERY SELECT (s ->> 'hasProfile')::boolean, (s ->> 'phoneVerified')::boolean,
                      (s ->> 'hasBirthdate')::boolean, (s ->> 'isAdult')::boolean,
                      (s ->> 'provisioned')::boolean, (s ->> 'pinSet')::boolean,
                      (s ->> 'phoneRecorded')::boolean, (s ->> 'phoneReverifyRequired')::boolean;
END $$;

-- ---------------------------------------------------------------- step 1, replaced
CREATE OR REPLACE FUNCTION core.record_phone_verified(phone_fingerprint bytea, email_fingerprint bytea) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor     uuid := core.actor_id();
  confirmed boolean;
  holder    record;
  u         record;
  conflict_msg constant text := 'This phone number or email already belongs to another account.';
BEGIN
  IF actor IS NULL THEN
    PERFORM core.fail('FORBIDDEN', 'sign in to continue');
  END IF;
  IF phone_fingerprint IS NULL OR octet_length(phone_fingerprint) <> 32
     OR email_fingerprint IS NULL OR octet_length(email_fingerprint) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'fingerprints are 32-byte HMACs');
  END IF;
  IF NOT core.auth_phone_confirmed(actor) THEN
    PERFORM core.fail('PHONE_REQUIRED', 'confirm your phone number first');
  END IF;
  -- 'sms' mode: this claim is confirmed by the sign-in service (or the trusted local stand-in)
  confirmed := core.phone_verification_mode() = 'sms';

  SELECT p.id INTO holder FROM core.user_profile p
   WHERE p.id <> actor AND p.phone_fingerprint = record_phone_verified.phone_fingerprint;
  IF FOUND THEN
    -- both rows, ascending id (LLD §4), then re-validate
    PERFORM 1 FROM core.user_profile p WHERE p.id IN (actor, holder.id) ORDER BY p.id FOR NO KEY UPDATE;
    SELECT p.id, p.phone_verified, p.phone_verified_at, p.provisioned_at INTO holder
      FROM core.user_profile p
     WHERE p.id = holder.id AND p.phone_fingerprint = record_phone_verified.phone_fingerprint;
    IF FOUND THEN
      IF holder.phone_verified IS FALSE
         AND (confirmed
              OR (holder.provisioned_at IS NULL
                  AND holder.phone_verified_at < clock_timestamp()
                        - make_interval(hours => core.phone_setting('phone_unverified_claim_hours', 24)))) THEN
        PERFORM core.phone_claim_release(holder.id);
      ELSE
        PERFORM core.fail('CONFLICT', conflict_msg);
      END IF;
    END IF;
  END IF;

  INSERT INTO core.user_profile (id, email_fingerprint) VALUES (actor, email_fingerprint) ON CONFLICT DO NOTHING;
  SELECT p.phone_fingerprint, p.phone_verified_at, p.phone_verified, p.provisioned_at INTO u
    FROM core.user_profile p WHERE p.id = actor FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM core.fail('CONFLICT', conflict_msg);   -- the email fingerprint is another account's
  END IF;
  IF u.phone_fingerprint = record_phone_verified.phone_fingerprint AND u.phone_verified_at IS NOT NULL
     AND (u.phone_verified IS TRUE OR NOT confirmed) THEN
    DELETE FROM core.phone_hold h WHERE h.user_id = actor AND confirmed;
    RETURN core.onboarding_status_of(actor);       -- already recorded (an unverified one is upgraded below)
  END IF;
  IF u.provisioned_at IS NOT NULL THEN
    PERFORM core.require_recent_sign_in();          -- changing the phone of a provisioned account
  END IF;
  BEGIN
    UPDATE core.user_profile p SET phone_fingerprint = record_phone_verified.phone_fingerprint,
                                   phone_verified_at = now(),
                                   phone_reverify_required = false
     WHERE p.id = actor;
  EXCEPTION WHEN unique_violation THEN
    PERFORM core.fail('CONFLICT', conflict_msg);   -- taken concurrently
  END;
  IF confirmed THEN
    DELETE FROM core.phone_hold h WHERE h.user_id = actor;
  END IF;
  RETURN core.onboarding_status_of(actor);
END $$;

-- ---------------------------------------------------------------- sms-mode bookkeeping
CREATE TABLE core.phone_attempt (
  user_id  uuid NOT NULL,
  phone_fp bytea NOT NULL CHECK (octet_length(phone_fp) = 32),
  first_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, phone_fp)
);
CREATE TABLE core.phone_hold (
  user_id  uuid PRIMARY KEY,
  phone_fp bytea NOT NULL CHECK (octet_length(phone_fp) = 32),
  set_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX phone_hold_set_at ON core.phone_hold (set_at);
ALTER TABLE core.phone_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.phone_hold ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.phone_attempt USING (false) WITH CHECK (false);
CREATE POLICY owner_only ON core.phone_hold USING (false) WITH CHECK (false);
REVOKE ALL ON core.phone_attempt, core.phone_hold
  FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- The actor asks for a code to the number with this fingerprint: 'KNOWN' (asked before), 'NEW'
-- (recorded now) or 'LIMIT' (too many distinct numbers; nothing recorded).
CREATE FUNCTION core.phone_number_attempt(p_phone_fp bytea) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor       uuid := core.require_actor();
  provisioned boolean;
BEGIN
  IF p_phone_fp IS NULL OR octet_length(p_phone_fp) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the fingerprint is a 32-byte HMAC');
  END IF;
  PERFORM core.lock_actor('core.phone_attempt', actor);
  IF EXISTS (SELECT 1 FROM core.phone_attempt a WHERE a.user_id = actor AND a.phone_fp = p_phone_fp) THEN
    RETURN 'KNOWN';
  END IF;
  provisioned := EXISTS (SELECT 1 FROM core.user_profile p WHERE p.id = actor AND p.provisioned_at IS NOT NULL);
  IF (SELECT count(*) FROM core.phone_attempt a
       WHERE a.user_id = actor AND a.first_at > clock_timestamp() - interval '24 hours')
       >= core.phone_setting('phone_numbers_per_day', 3)
     OR (NOT provisioned
         AND (SELECT count(*) FROM core.phone_attempt a WHERE a.user_id = actor)
             >= core.phone_setting('phone_numbers_lifetime', 5)) THEN
    RETURN 'LIMIT';
  END IF;
  INSERT INTO core.phone_attempt (user_id, phone_fp) VALUES (actor, p_phone_fp);
  RETURN 'NEW';
END $$;

-- The server set this (unconfirmed) number on the actor's sign-in user. A resend of the same number
-- keeps the hold's first time, so resending cannot keep a squatted number held past the lifetime.
CREATE FUNCTION core.phone_hold_set(p_phone_fp bytea) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  actor uuid := core.require_actor();
BEGIN
  IF p_phone_fp IS NULL OR octet_length(p_phone_fp) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the fingerprint is a 32-byte HMAC');
  END IF;
  INSERT INTO core.phone_hold AS h (user_id, phone_fp) VALUES (actor, p_phone_fp)
  ON CONFLICT (user_id) DO UPDATE
    SET phone_fp = EXCLUDED.phone_fp,
        set_at = CASE WHEN h.phone_fp = EXCLUDED.phone_fp THEN h.set_at ELSE clock_timestamp() END;
END $$;

-- The job runner: holds older than the code lifetime (oldest first).
CREATE FUNCTION core.phone_holds_expired(p_limit int) RETURNS TABLE (user_id uuid, phone_fp bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.user_id, h.phone_fp FROM core.phone_hold h
   WHERE h.set_at < clock_timestamp() - make_interval(secs => core.phone_setting('phone_code_lifetime_seconds', 600))
   ORDER BY h.set_at
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
$$;

-- The job runner released (or found nothing to release for) this hold.
CREATE FUNCTION core.phone_hold_done(p_user uuid, p_phone_fp bytea) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM core.phone_hold h WHERE h.user_id = p_user AND h.phone_fp = p_phone_fp;
  RETURN FOUND;
END $$;

-- The holder of a number the sign-in service refused as taken, when it may be released.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'phone')
     AND EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'phone_confirmed_at') THEN
    CREATE FUNCTION core.auth_phone_holder(p_phone text, p_phone_fp bytea) RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
    DECLARE
      actor  uuid := core.actor_id();
      holder uuid;
    BEGIN
      IF actor IS NULL OR p_phone IS NULL OR p_phone !~ '^[0-9]{6,15}$'
         OR p_phone_fp IS NULL OR octet_length(p_phone_fp) <> 32 THEN
        RETURN NULL;
      END IF;
      SELECT u.id INTO holder
        FROM auth.users u LEFT JOIN core.phone_hold h ON h.user_id = u.id AND h.phone_fp = p_phone_fp
       WHERE u.phone = p_phone AND u.id <> actor
         AND u.phone_confirmed_at IS NULL
         AND COALESCE(h.set_at, u.created_at)
               < clock_timestamp() - make_interval(secs => core.phone_setting('phone_code_lifetime_seconds', 600))
       LIMIT 1;
      RETURN holder;
    END $f$;
  ELSE
    -- the local stand-in keeps no phone numbers: there is never a holder to release
    CREATE FUNCTION core.auth_phone_holder(p_phone text, p_phone_fp bytea) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
      SELECT NULL::uuid
    $f$;
  END IF;
END $do$;

REVOKE ALL ON FUNCTION core.phone_setting(text, int), core.phone_claim_release(uuid), core.onboarding_status_of(uuid),
  core.onboarding_status(), core.record_phone_verified(bytea, bytea), core.phone_number_attempt(bytea),
  core.phone_hold_set(bytea), core.phone_holds_expired(int), core.phone_hold_done(uuid, bytea),
  core.auth_phone_holder(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.onboarding_status(), core.record_phone_verified(bytea, bytea) TO app_pay;
GRANT EXECUTE ON FUNCTION core.phone_number_attempt(bytea), core.phone_hold_set(bytea),
  core.auth_phone_holder(text, bytea) TO app_web;
GRANT EXECUTE ON FUNCTION core.phone_holds_expired(int), core.phone_hold_done(uuid, bytea) TO app_jobs;
