-- Deployment settings and the phone verification mode (production on Supabase).
--
-- core.deployment_setting holds the few values that are a deployment decision of the OWNER, not a
-- product configuration (core.config_version) and not something any application role may change:
--
--   identity.phone_verification   'sms' (default): the phone step needs the sign-in service to have
--                                 confirmed the number by SMS code (auth.users.phone_confirmed_at,
--                                 0024). 'unverified': the number is recorded WITHOUT an SMS code
--                                 (no SMS spend at launch); its keyed fingerprint is still unique,
--                                 so one account per phone number still holds, and the profile is
--                                 marked phone_verified = false.
--   auth.session_max_age_seconds  the absolute lifetime of a sign-in session (0071), counted from
--                                 auth.sessions.created_at. Default 604800 (7 days).
--
-- No application role holds any privilege on the table and no function an application role may
-- execute writes it: switching to 'unverified' is an owner action, e.g. in the Supabase SQL editor
--   UPDATE core.deployment_setting SET value = 'unverified', updated_at = now()
--    WHERE key = 'identity.phone_verification';
-- The web server only READS the mode, through core.phone_verification_mode().

CREATE TABLE core.deployment_setting (
  key        text PRIMARY KEY CHECK (key IN ('identity.phone_verification', 'auth.session_max_age_seconds')),
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_setting_value CHECK (
    (key = 'identity.phone_verification' AND value IN ('sms', 'unverified'))
    -- 5 minutes to 90 days
    OR (key = 'auth.session_max_age_seconds' AND value ~ '^[0-9]{3,7}$'
        AND value::int BETWEEN 300 AND 7776000))
);
ALTER TABLE core.deployment_setting ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.deployment_setting USING (false) WITH CHECK (false);
REVOKE ALL ON core.deployment_setting FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

INSERT INTO core.deployment_setting (key, value) VALUES
  ('identity.phone_verification', 'sms'),
  ('auth.session_max_age_seconds', '604800');

-- The phone verification mode: 'sms' unless the owner switched it. Never raises.
CREATE FUNCTION core.phone_verification_mode() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE((SELECT s.value FROM core.deployment_setting s WHERE s.key = 'identity.phone_verification'),
                  'sms')
$$;

-- The absolute session lifetime in seconds (default 7 days). Never raises.
CREATE FUNCTION core.session_max_age_seconds() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE((SELECT s.value::int FROM core.deployment_setting s WHERE s.key = 'auth.session_max_age_seconds'),
                  604800)
$$;

-- ---------------------------------------------------------------- the sign-in service's SMS flag
-- The strict check of 0024, unchanged in meaning: with Supabase Auth (auth.users.phone_confirmed_at
-- present) the actor's phone must be confirmed by the sign-in service; with the local stand-in of
-- 0001 (no such column) the caller is trusted. Chosen when this migration runs.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'phone_confirmed_at') THEN
    CREATE FUNCTION core.auth_phone_sms_confirmed(actor uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
      SELECT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = actor AND u.phone_confirmed_at IS NOT NULL)
    $f$;
  ELSE
    -- TRUSTED CALLER: no sign-in-service flag to check (local stand-in)
    CREATE FUNCTION core.auth_phone_sms_confirmed(actor uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
      SELECT actor IS NOT NULL
    $f$;
  END IF;
END $do$;

-- What core.record_phone_verified (0024) asks before recording a phone. Relaxed ONLY in
-- 'unverified' mode, which only the owner can switch on.
CREATE OR REPLACE FUNCTION core.auth_phone_confirmed(actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE core.phone_verification_mode()
           WHEN 'unverified' THEN actor IS NOT NULL
           ELSE core.auth_phone_sms_confirmed(actor)
         END
$$;

-- ---------------------------------------------------------------- the profile says which it was
-- phone_verified: NULL without a phone; true when the recorded number was confirmed by SMS (or by
-- the trusted caller of the local stand-in); false when it was recorded in 'unverified' mode. Set
-- by the trigger below whenever the phone changes, whoever writes it: no application role holds
-- INSERT or UPDATE on core.user_profile (0011), and the value never comes from a caller.
ALTER TABLE core.user_profile ADD COLUMN phone_verified boolean;
UPDATE core.user_profile SET phone_verified = true WHERE phone_fingerprint IS NOT NULL;

CREATE FUNCTION core.set_profile_phone_verified() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.phone_fingerprint IS NULL THEN
    NEW.phone_verified := NULL;
  ELSIF TG_OP = 'INSERT'
        OR NEW.phone_fingerprint IS DISTINCT FROM OLD.phone_fingerprint
        OR NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at THEN
    NEW.phone_verified := core.phone_verification_mode() = 'sms';
  ELSE
    NEW.phone_verified := OLD.phone_verified;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profile_phone_verified BEFORE INSERT OR UPDATE ON core.user_profile
  FOR EACH ROW EXECUTE FUNCTION core.set_profile_phone_verified();

REVOKE ALL ON FUNCTION core.phone_verification_mode(), core.session_max_age_seconds(),
  core.auth_phone_sms_confirmed(uuid), core.set_profile_phone_verified() FROM PUBLIC;
-- the web server reads the mode on its app_web pool (the definer functions above read it as owner)
GRANT EXECUTE ON FUNCTION core.phone_verification_mode() TO app_web;
