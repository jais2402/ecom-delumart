-- Operations health for the Super Admin (GET /api/v1/admin/health).
--
-- core.jobs_heartbeat keeps the time of the last accepted job run: a trigger on the replay guard's
-- table (core.jobs_request_seen, 0048) records every signed run the database accepted, whoever
-- scheduled it (the daily platform cron or an external scheduler). Rows of the replay guard are
-- purged after two minutes; the heartbeat stays.
--
-- core.admin_health() answers the Super Admin only (FORBIDDEN for anyone else before anything is
-- read) with deployment facts that contain no secret and no personal data: the latest applied
-- migration, the phone verification mode, the session lifetime and the last job run.

CREATE TABLE core.jobs_heartbeat (
  kind    text PRIMARY KEY CHECK (kind IN ('run')),
  last_at timestamptz NOT NULL,
  runs    bigint NOT NULL DEFAULT 1 CHECK (runs >= 1)
);
ALTER TABLE core.jobs_heartbeat ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.jobs_heartbeat USING (false) WITH CHECK (false);
REVOKE ALL ON core.jobs_heartbeat FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

CREATE FUNCTION core.jobs_heartbeat_touch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO core.jobs_heartbeat AS h (kind, last_at) VALUES ('run', clock_timestamp())
  ON CONFLICT (kind) DO UPDATE SET last_at = GREATEST(h.last_at, EXCLUDED.last_at), runs = h.runs + 1;
  RETURN NULL;
END $$;
CREATE TRIGGER jobs_heartbeat AFTER INSERT ON core.jobs_request_seen
  FOR EACH ROW EXECUTE FUNCTION core.jobs_heartbeat_touch();

CREATE FUNCTION core.admin_health() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_migration text;
BEGIN
  PERFORM core.admin_actor();   -- FORBIDDEN unless the signed-in Super Admin
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT max(version) FROM public.schema_migrations' INTO v_migration;
  END IF;
  RETURN jsonb_build_object(
    'migrationVersion', v_migration,
    'phoneVerification', core.phone_verification_mode(),
    'sessionMaxAgeSeconds', core.session_max_age_seconds(),
    'jobsLastRunAt', (SELECT to_char(h.last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                        FROM core.jobs_heartbeat h WHERE h.kind = 'run'),
    'jobsRuns', (SELECT h.runs FROM core.jobs_heartbeat h WHERE h.kind = 'run'));
END $$;

REVOKE ALL ON FUNCTION core.jobs_heartbeat_touch(), core.admin_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_health() TO app_web;
