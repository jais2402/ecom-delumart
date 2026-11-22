-- Session lifetime and sign-out without the sign-in service's tokens (production on Supabase).
--
-- The web server never keeps a Supabase access or refresh token (apps/web/src/server/auth): after
-- the sign-in callback it holds only the opaque cookie with the auth.sessions id, and
-- core.actor_id() decides on every call whether that session still signs anyone in. Two gaps
-- follow on Supabase's free plan, closed here in the database:
--
--  1. Lifetime. Without a refresh, nothing ever ends a Supabase session row (not_after stays NULL
--     unless the paid "time-box" setting is on), so a copied cookie would work forever. A session
--     now also stops signing anyone in core.session_max_age_seconds() (0070, default 7 days) after
--     auth.sessions.created_at; the user signs in again.
--  2. Sign-out. Supabase's logout endpoint needs the user's (unexpired) access token, which the
--     server does not keep. core.end_session() records the caller's session in core.ended_session,
--     which core.actor_id() consults, and also deletes the auth.sessions row when the owner may
--     (on Supabase that privilege is not guaranteed; the record alone is what signs it out here).
--
-- core.actor_id() is otherwise exactly as in 0001.

CREATE TABLE core.ended_session (
  session_id uuid PRIMARY KEY,
  ended_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ended_session_at ON core.ended_session (ended_at);
ALTER TABLE core.ended_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.ended_session USING (false) WITH CHECK (false);
REVOKE ALL ON core.ended_session FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

CREATE OR REPLACE FUNCTION core.actor_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  raw     text := current_setting('app.session_id', true);
  invoker text := CASE WHEN COALESCE(current_setting('role', true), 'none') <> 'none'
                       THEN current_setting('role', true) ELSE session_user::text END;
  actor   uuid;
BEGIN
  IF invoker IN ('app_jobs', 'npc_worker', 'research_ro')
     OR raw IS NULL
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  SELECT s.user_id INTO actor
    FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
   WHERE s.id = raw::uuid
     AND (s.not_after IS NULL OR s.not_after > clock_timestamp())
     AND s.created_at > clock_timestamp() - make_interval(secs => core.session_max_age_seconds())
     AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
     AND u.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM core.ended_session e WHERE e.session_id = s.id);
  RETURN actor;
END $$;

-- Signs the caller's session out for good (app_web, with app.session_id set from the cookie).
-- Idempotent; a malformed or unknown id does nothing; never raises for a missing privilege on
-- auth.sessions and never echoes the id. Rows older than any session could live are purged here.
CREATE FUNCTION core.end_session() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  raw text := current_setting('app.session_id', true);
  sid uuid;
BEGIN
  IF raw IS NULL OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  sid := raw::uuid;
  IF NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = sid) THEN
    RETURN;   -- nothing to end: a made-up id is not remembered
  END IF;
  INSERT INTO core.ended_session (session_id) VALUES (sid) ON CONFLICT (session_id) DO NOTHING;
  -- a row older than the longest session lifetime (plus a day) can no longer matter
  DELETE FROM core.ended_session e
   WHERE e.ended_at < clock_timestamp() - make_interval(secs => core.session_max_age_seconds()) - interval '1 day';
  BEGIN
    DELETE FROM auth.sessions s WHERE s.id = sid;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;   -- the managed platform keeps auth.* to itself; core.ended_session already ends it here
  END;
END $$;

REVOKE ALL ON FUNCTION core.end_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.end_session() TO app_web;
