-- Ninth security review, minors 3 and 4: only sessions this application accepted sign anyone in,
-- and an ended session stays ended whatever the owner later sets as the session lifetime.
--
-- MINOR 4. core.actor_id() (0071) accepted ANY live auth.sessions row. On Supabase a session row
-- can be minted without this application: an implicit-flow sign-in, a phone OTP sign-in, a
-- password sign-up, anyone calling the public Auth API with the publishable key. Whoever then put
-- that session id in the cookie was signed in here although the web server never verified a token
-- for it. Now:
--   * core.app_session(session_id, user_id, accepted_at) lists the sessions the web server
--     accepted. No application role reads or writes it;
--   * core.register_app_session(session, user) is the only writer (EXECUTE: app_web). The web
--     server calls it in the sign-in callback / code check AFTER it verified the access token, and
--     the function itself re-checks that the auth.sessions row exists, belongs to that user, is
--     live (not ended, not past not_after or the session lifetime), that the user is neither
--     banned nor deleted and that auth.users.is_anonymous is not true;
--   * core.actor_id() requires the session's app_session row in addition to everything it checked.
-- The extra Supabase session a phone verification creates is never registered (and is logged out
-- at once): it can never sign anyone in here.
--
-- MINOR 3. core.end_session() purged core.ended_session rows older than the CURRENT session
-- lifetime plus a day. With a short lifetime the record of a sign-out went away while the managed
-- platform kept the auth.sessions row; raising auth.session_max_age_seconds later brought that
-- session back to life. A record is now purged only when it is older than the LONGEST lifetime
-- the setting allows (7776000 s, 90 days, the CHECK of 0070) plus one day, or when its
-- auth.sessions row no longer exists (a session that does not exist cannot sign anyone in).
-- core.app_session rows are purged by the same two rules.

CREATE TABLE core.app_session (
  session_id  uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX app_session_accepted ON core.app_session (accepted_at);
ALTER TABLE core.app_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.app_session USING (false) WITH CHECK (false);
REVOKE ALL ON core.app_session FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- The longest session lifetime the owner setting may ever hold (0070's CHECK), in seconds.
CREATE FUNCTION core.session_max_age_ceiling_seconds() RETURNS int
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT 7776000
$$;

-- Whether the sign-in service marks the user anonymous (auth.users.is_anonymous on Supabase).
-- Chosen when this migration runs, like 0070: the local stand-in of 0001 has no such column and
-- no anonymous users.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'is_anonymous') THEN
    CREATE FUNCTION core.auth_user_is_anonymous(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
      SELECT COALESCE((SELECT u.is_anonymous IS TRUE FROM auth.users u WHERE u.id = p_user), true)
    $f$;
  ELSE
    -- the local stand-in: no anonymous sign-ins exist
    CREATE FUNCTION core.auth_user_is_anonymous(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
      SELECT p_user IS NULL
    $f$;
  END IF;
END $do$;

-- Records that the web server accepted this session for this user. True when it is (now)
-- registered; false, and nothing written, for anything the checks above refuse. Never raises for
-- an unknown id and never echoes it.
CREATE FUNCTION core.register_app_session(p_session_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
BEGIN
  IF p_session_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
        WHERE s.id = p_session_id AND s.user_id = p_user_id
          AND (s.not_after IS NULL OR s.not_after > clock_timestamp())
          AND s.created_at > clock_timestamp() - make_interval(secs => core.session_max_age_seconds())
          AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
          AND u.deleted_at IS NULL)
     OR core.auth_user_is_anonymous(p_user_id)
     OR EXISTS (SELECT 1 FROM core.ended_session e WHERE e.session_id = p_session_id) THEN
    RETURN false;
  END IF;
  INSERT INTO core.app_session (session_id, user_id) VALUES (p_session_id, p_user_id)
  ON CONFLICT (session_id) DO NOTHING;
  RETURN EXISTS (SELECT 1 FROM core.app_session a WHERE a.session_id = p_session_id AND a.user_id = p_user_id);
END $$;

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
    FROM auth.sessions s
    JOIN auth.users u ON u.id = s.user_id
    JOIN core.app_session a ON a.session_id = s.id AND a.user_id = s.user_id
   WHERE s.id = raw::uuid
     AND (s.not_after IS NULL OR s.not_after > clock_timestamp())
     AND s.created_at > clock_timestamp() - make_interval(secs => core.session_max_age_seconds())
     AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
     AND u.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM core.ended_session e WHERE e.session_id = s.id);
  RETURN actor;
END $$;

-- As 0071, with the purge of minor 3 (and of core.app_session), in bounded batches.
CREATE OR REPLACE FUNCTION core.end_session() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  raw     text := current_setting('app.session_id', true);
  sid     uuid;
  horizon timestamptz := clock_timestamp() - make_interval(secs => core.session_max_age_ceiling_seconds())
                         - interval '1 day';
BEGIN
  IF raw IS NULL OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN;
  END IF;
  sid := raw::uuid;
  IF NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = sid) THEN
    RETURN;   -- nothing to end: a made-up id is not remembered
  END IF;
  INSERT INTO core.ended_session (session_id) VALUES (sid) ON CONFLICT (session_id) DO NOTHING;
  BEGIN
    DELETE FROM auth.sessions s WHERE s.id = sid;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;   -- the managed platform keeps auth.* to itself; core.ended_session already ends it here
  END;
  -- a record can matter only while its session row exists and could still be young enough under
  -- the LONGEST lifetime the owner may ever set
  DELETE FROM core.ended_session e
   WHERE e.session_id IN (
     SELECT x.session_id FROM core.ended_session x
      WHERE x.session_id <> sid
        AND (x.ended_at < horizon
             OR NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = x.session_id))
      LIMIT 500);
  DELETE FROM core.app_session a
   WHERE a.session_id IN (
     SELECT x.session_id FROM core.app_session x
      WHERE x.accepted_at < horizon
         OR NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = x.session_id)
      LIMIT 500);
END $$;

REVOKE ALL ON FUNCTION core.session_max_age_ceiling_seconds(), core.auth_user_is_anonymous(uuid),
  core.register_app_session(uuid, uuid), core.end_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.register_app_session(uuid, uuid), core.end_session() TO app_web;
