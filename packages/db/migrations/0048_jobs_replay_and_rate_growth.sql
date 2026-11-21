-- Sixth security review, minors 9 and 10.
--
-- 9. Jobs endpoint replay. A signed POST /api/internal/jobs/run was accepted again and again within
--    its 60-second window. The route now records each accepted signature (a SHA-256 of it, never the
--    signature) with the request's signed timestamp through core.jobs_accept_request, which refuses
--    a signature it has seen (false) and purges entries older than two minutes (a signed timestamp
--    is accepted at most 60 seconds either side of the server clock, so an entry is never needed
--    for longer). The route fails closed: when this call fails, nothing runs.
--
-- 10. Rate counter growth. Each counter now records its window length; core.rate_purge (run on every
--    job run) deletes every window that has ended, besides those older than `older_than`, and caps
--    the table at `rate_counter_max_rows` (200000) rows by deleting the oldest windows beyond it.
--    (The web server hashes an IPv6 client by its /64 prefix, so one host cannot fan out over its
--    addresses.)

-- ---------------------------------------------------------------- 9. replay guard
CREATE TABLE core.jobs_request_seen (
  signature_hash bytea PRIMARY KEY CHECK (octet_length(signature_hash) = 32),
  request_at     timestamptz NOT NULL,
  seen_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX jobs_request_seen_at ON core.jobs_request_seen (seen_at);
ALTER TABLE core.jobs_request_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.jobs_request_seen FROM PUBLIC, anon, authenticated, app_web, app_pay, app_jobs, npc_worker, research_ro;
CREATE POLICY owner_only ON core.jobs_request_seen USING (false) WITH CHECK (false);

-- true: first sight of this signature (recorded); false: a replay.
CREATE FUNCTION core.jobs_accept_request(p_signature_hash bytea, p_request_at timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  n int;
BEGIN
  IF p_signature_hash IS NULL OR octet_length(p_signature_hash) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the signature hash is a 32-byte digest');
  END IF;
  IF p_request_at IS NULL OR p_request_at < clock_timestamp() - interval '2 minutes'
     OR p_request_at > clock_timestamp() + interval '2 minutes' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'the request time is outside the replay window');
  END IF;
  DELETE FROM core.jobs_request_seen s
   WHERE GREATEST(s.seen_at, s.request_at) < clock_timestamp() - interval '2 minutes';
  INSERT INTO core.jobs_request_seen (signature_hash, request_at) VALUES (p_signature_hash, p_request_at)
  ON CONFLICT (signature_hash) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION core.jobs_accept_request(bytea, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.jobs_accept_request(bytea, timestamptz) TO app_jobs;

-- ---------------------------------------------------------------- 10. counters know their window
ALTER TABLE core.rate_counter ADD COLUMN window_seconds int NOT NULL DEFAULT 86400
  CHECK (window_seconds BETWEEN 1 AND 86400);
CREATE INDEX rate_counter_window ON core.rate_counter (window_start);

CREATE OR REPLACE FUNCTION core.rate_hit(scope text, subject bytea, window_seconds int, max_hits int) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  w timestamptz;
  n int;
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
  w := to_timestamp(floor(extract(epoch FROM clock_timestamp()) / window_seconds) * window_seconds);
  INSERT INTO core.rate_counter AS rc (scope, subject, window_start, count, window_seconds)
  VALUES (rate_hit.scope, rate_hit.subject, w, 1, rate_hit.window_seconds)
  ON CONFLICT ON CONSTRAINT rate_counter_pkey
    DO UPDATE SET count = LEAST(rc.count, 1000000) + 1,
                  window_seconds = GREATEST(rc.window_seconds, EXCLUDED.window_seconds)
  RETURNING rc.count INTO n;
  RETURN n <= max_hits;
END $$;

-- Deletes ended windows and windows that started more than older_than ago (at least two days),
-- then the oldest windows beyond the row cap; returns how many rows went.
CREATE OR REPLACE FUNCTION core.rate_purge(older_than interval DEFAULT '2 days') RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n     int;
  extra int;
  cap   bigint := core.config_int(core.current_config_id(), ARRAY['rate_counter_max_rows'], 200000);
BEGIN
  IF older_than IS NULL OR older_than < interval '2 days' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'older_than is at least two days');
  END IF;
  DELETE FROM core.rate_counter rc
   WHERE rc.window_start < clock_timestamp() - older_than
      OR rc.window_start + make_interval(secs => rc.window_seconds) <= clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT GREATEST(count(*) - cap, 0) INTO extra FROM core.rate_counter;
  IF extra > 0 THEN
    DELETE FROM core.rate_counter rc
     WHERE (rc.scope, rc.subject, rc.window_start) IN (
       SELECT o.scope, o.subject, o.window_start FROM core.rate_counter o
        ORDER BY o.window_start, o.scope, o.subject LIMIT extra);
    n := n + extra;
  END IF;
  RETURN n;
END $$;
