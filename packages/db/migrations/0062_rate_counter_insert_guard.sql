-- The rate counter's hard insert guard (eighth security review, minor 8b).
--
-- 0057 keeps every live window ("never evict a live window") and only records the overflow, so a
-- flood of new subjects (addresses, sessions) could still grow core.rate_counter without bound
-- until the purge. Now, when the table holds `rate_counter_max_rows` (200000) rows or more:
--   * core.rate_hit for a NEW subject (no row of that scope and subject in any window) answers
--     false, the normal rate-limited answer, and stores nothing: new subjects fail closed;
--   * a subject that already has a row continues as before (its windows are counted and kept);
--   * one SYSTEM audit row 'rate.over_cap' is written per UTC hour, whoever notices first (the
--     purge or a refused hit): core.rate_cap_alert holds the hours already reported.
-- The size is the statistics system's live row count (pg_stat_get_live_tuples): cheap on every
-- hit, and current to within the statistics flush interval (about a second).

CREATE TABLE core.rate_cap_alert (
  hour timestamptz PRIMARY KEY CHECK (hour = date_trunc('hour', hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
);
ALTER TABLE core.rate_cap_alert ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON core.rate_cap_alert USING (false) WITH CHECK (false);
REVOKE ALL ON core.rate_cap_alert FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;

CREATE FUNCTION core.rate_counter_cap() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.config_int(core.current_config_id(), ARRAY['rate_counter_max_rows'], 200000)::bigint
$$;

-- Records the overflow once per UTC hour (concurrent callers: the primary key decides).
CREATE FUNCTION core.rate_over_cap_alert(p_rows bigint, p_cap bigint, p_what text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_hour timestamptz := date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_new  bigint;
BEGIN
  INSERT INTO core.rate_cap_alert (hour) VALUES (v_hour) ON CONFLICT (hour) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;
  IF v_new = 1 AND NOT EXISTS (SELECT 1 FROM audit.audit_log l
                            WHERE l.action = 'rate.over_cap' AND l.actor_kind = 'SYSTEM' AND l.created_at >= v_hour) THEN
    PERFORM audit.append_chained(NULL, 'SYSTEM', 'rate.over_cap', 'rate_counter', 'core.rate_counter',
      format('%s rate windows exceed the cap of %s; %s', p_rows, p_cap, p_what),
      jsonb_build_object('rows', p_rows, 'cap', p_cap));
    RETURN true;
  END IF;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION core.rate_hit(scope text, subject bytea, window_seconds integer, max_hits integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  w   timestamptz;
  n   int;
  cap bigint;
  sz  bigint;
BEGIN
  IF scope IS NULL OR scope !~ '^[a-z][a-z0-9_.:-]{0,63}$' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'scope is a short lowercase name');
  END IF;
  IF subject IS NULL OR octet_length(subject) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'subject is a 32-byte digest');
  END IF;
  IF window_seconds IS NULL OR window_seconds < 1 OR window_seconds > 86400 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'window_seconds is 1 to 86400');
  END IF;
  IF max_hits IS NULL OR max_hits < 1 OR max_hits > 1000000 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'max_hits is 1 to 1000000');
  END IF;
  -- the insert guard: over the cap, a subject the table does not hold yet is refused (fail closed)
  IF NOT EXISTS (SELECT 1 FROM core.rate_counter rc WHERE rc.scope = rate_hit.scope AND rc.subject = rate_hit.subject) THEN
    cap := core.rate_counter_cap();
    sz := pg_stat_get_live_tuples('core.rate_counter'::regclass);
    IF sz >= cap THEN
      PERFORM core.rate_over_cap_alert(sz, cap, 'new subjects are refused until the purge makes room');
      RETURN false;
    END IF;
  END IF;
  w := to_timestamp(floor(extract(epoch FROM clock_timestamp()) / window_seconds) * window_seconds);
  INSERT INTO core.rate_counter AS rc (scope, subject, window_start, count, window_seconds)
  VALUES (rate_hit.scope, rate_hit.subject, w, 1, rate_hit.window_seconds)
  ON CONFLICT ON CONSTRAINT rate_counter_pkey
    DO UPDATE SET count = LEAST(rc.count, 1000000) + 1,
                  window_seconds = GREATEST(rc.window_seconds, EXCLUDED.window_seconds)
  RETURNING rc.count INTO n;
  RETURN n <= max_hits;
END $$;

CREATE OR REPLACE FUNCTION core.rate_purge(older_than interval DEFAULT '2 days') RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n     int;
  total bigint;
  cap   bigint := core.rate_counter_cap();
BEGIN
  IF older_than IS NULL OR older_than < interval '2 days' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'older_than is at least two days');
  END IF;
  -- ended windows only (a window older than two days has always ended: windows are at most a day)
  DELETE FROM core.rate_counter rc
   WHERE rc.window_start < clock_timestamp() - older_than
      OR rc.window_start + make_interval(secs => rc.window_seconds) <= clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT count(*) INTO total FROM core.rate_counter;
  IF total > cap THEN
    -- every row left is a live window: none is evicted; the overflow is recorded once per hour
    PERFORM core.rate_over_cap_alert(total, cap, 'none was evicted');
  END IF;
  DELETE FROM core.rate_cap_alert a WHERE a.hour < clock_timestamp() - interval '2 days';
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION core.rate_counter_cap(), core.rate_over_cap_alert(bigint, bigint, text) FROM PUBLIC;
