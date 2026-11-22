-- Ninth security review, major 2c: filling core.rate_counter must not shut sign-in down.
--
-- 0062 refused every NEW subject once the table held `rate_counter_max_rows` (200000) rows, so a
-- flood of fresh addresses could stop every first sign-in attempt and every first payment until the
-- purge. Now, for a hit of a subject the table does not hold yet:
--   1. per network: a hit that names its client network (`p_net`, a keyed digest of the IPv6 /48
--      the web server computed; NULL for IPv4 and for non-address subjects) is refused when that
--      network already holds `rate_counter_subjects_per_net` (64) distinct live subjects: one
--      /48 (65536 /64s) cannot create subjects without bound;
--   2. at or over the SOFT cap (`rate_counter_max_rows`): the oldest-started rows of ADDRESS-scoped
--      subjects (scope ending '.address') whose count is 1 (the cheapest to forget and the least
--      informative) are evicted, `rate_counter_evict_batch` (64) at a time; when that made room
--      the hit is counted;
--   3. nothing evictable: a scope essential to signing in and paying (auth.*, phone.*, pin.*,
--      checkout.*) is still counted until the table reaches the HARD cap
--      (`rate_counter_hard_max_rows`, 250000); anything else is refused (the normal rate-limited
--      answer, nothing stored);
--   4. while over the soft cap, one SYSTEM audit row per hour (core.rate_over_cap_alert, 0062).
-- Subjects the table already holds continue as before. Live windows of every other kind are still
-- never evicted, and the purge (0062) is unchanged.

ALTER TABLE core.rate_counter ADD COLUMN net bytea CHECK (net IS NULL OR octet_length(net) = 32);
CREATE INDEX rate_counter_net ON core.rate_counter (net) WHERE net IS NOT NULL;
CREATE INDEX rate_counter_evictable ON core.rate_counter (window_start)
  WHERE count = 1 AND scope LIKE '%.address';

CREATE FUNCTION core.rate_scope_essential(p_scope text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_scope LIKE 'auth.%' OR p_scope LIKE 'phone.%' OR p_scope LIKE 'pin.%' OR p_scope LIKE 'checkout.%'
$$;

CREATE FUNCTION core.rate_hit(scope text, subject bytea, window_seconds integer, max_hits integer, p_net bytea)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  w       timestamptz;
  n       int;
  cfg     int := core.current_config_id();
  cap     bigint;
  hard    bigint;
  sz      bigint;
  evicted int := 0;
BEGIN
  IF scope IS NULL OR scope !~ '^[a-z][a-z0-9_.:-]{0,63}$' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'scope is a short lowercase name');
  END IF;
  IF subject IS NULL OR octet_length(subject) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'subject is a 32-byte digest');
  END IF;
  IF p_net IS NOT NULL AND octet_length(p_net) <> 32 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'net is a 32-byte digest');
  END IF;
  IF window_seconds IS NULL OR window_seconds < 1 OR window_seconds > 86400 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'window_seconds is 1 to 86400');
  END IF;
  IF max_hits IS NULL OR max_hits < 1 OR max_hits > 1000000 THEN
    PERFORM core.fail('VALIDATION_FAILED', 'max_hits is 1 to 1000000');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.rate_counter rc WHERE rc.scope = rate_hit.scope AND rc.subject = rate_hit.subject) THEN
    -- 1. one network cannot create subjects without bound
    IF p_net IS NOT NULL
       AND (SELECT count(DISTINCT rc.subject) FROM core.rate_counter rc
             WHERE rc.net = p_net AND rc.subject <> rate_hit.subject
               AND rc.window_start + make_interval(secs => rc.window_seconds) > clock_timestamp())
           >= core.config_int(cfg, ARRAY['rate_counter_subjects_per_net'], 64) THEN
      RETURN false;
    END IF;
    cap := core.rate_counter_cap();
    sz := pg_stat_get_live_tuples('core.rate_counter'::regclass);
    IF sz >= cap THEN
      PERFORM core.rate_over_cap_alert(sz, cap, 'address subjects seen once are evicted; new non-essential subjects are refused');
      -- 2. make room from the cheapest rows
      DELETE FROM core.rate_counter rc
       WHERE (rc.scope, rc.subject, rc.window_start) IN (
         SELECT x.scope, x.subject, x.window_start FROM core.rate_counter x
          WHERE x.count = 1 AND x.scope LIKE '%.address'
          ORDER BY x.window_start
          LIMIT core.config_int(cfg, ARRAY['rate_counter_evict_batch'], 64)
          FOR UPDATE SKIP LOCKED);
      GET DIAGNOSTICS evicted = ROW_COUNT;
      IF evicted = 0 THEN
        -- 3. only what signing in and paying need, up to the hard cap
        hard := GREATEST(core.config_int(cfg, ARRAY['rate_counter_hard_max_rows'], 250000)::bigint, cap);
        IF NOT core.rate_scope_essential(rate_hit.scope) OR sz >= hard THEN
          RETURN false;
        END IF;
      END IF;
    END IF;
  END IF;
  w := to_timestamp(floor(extract(epoch FROM clock_timestamp()) / window_seconds) * window_seconds);
  INSERT INTO core.rate_counter AS rc (scope, subject, window_start, count, window_seconds, net)
  VALUES (rate_hit.scope, rate_hit.subject, w, 1, rate_hit.window_seconds, p_net)
  ON CONFLICT ON CONSTRAINT rate_counter_pkey
    DO UPDATE SET count = LEAST(rc.count, 1000000) + 1,
                  window_seconds = GREATEST(rc.window_seconds, EXCLUDED.window_seconds),
                  net = COALESCE(rc.net, EXCLUDED.net)
  RETURNING rc.count INTO n;
  RETURN n <= max_hits;
END $$;

-- the four-argument form (0062) keeps working, with no network
CREATE OR REPLACE FUNCTION core.rate_hit(scope text, subject bytea, window_seconds integer, max_hits integer)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT core.rate_hit(scope, subject, window_seconds, max_hits, NULL::bytea)
$$;

REVOKE ALL ON FUNCTION core.rate_scope_essential(text), core.rate_hit(text, bytea, integer, integer, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.rate_hit(text, bytea, integer, integer, bytea) TO app_web, app_pay;
