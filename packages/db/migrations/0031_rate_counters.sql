-- Rate limits in the database (fifth security review; LLD §11.2 "Postgres fixed-window counters").
--
-- The web server's security-relevant limits (sign-in, phone codes, PIN entry, coupon codes, cart
-- writes, checkout and pay) were in-memory counters keyed by session: a restart, a second
-- instance or a fresh sign-in reset them. They are now rows here, one per (scope, subject, fixed
-- window). The subject is an HMAC the web server computes (of the client address or of the user
-- id) so no raw address or id is stored.
--
-- core.rate_hit counts one hit and answers whether it is within max_hits. The server calls it in
-- its own short transaction, on a separate pooled connection, BEFORE the business call, so the
-- hit is committed even when the business transaction later rolls back (a wrong PIN, a refused
-- coupon). app_jobs purges expired windows with core.rate_purge.

CREATE TABLE core.rate_counter (
  scope        text        NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  subject      bytea       NOT NULL CHECK (octet_length(subject) = 32),
  window_start timestamptz NOT NULL,
  count        int         NOT NULL CHECK (count >= 1),
  PRIMARY KEY (scope, subject, window_start)
);
ALTER TABLE core.rate_counter ENABLE ROW LEVEL SECURITY;
-- no role but the owner (which bypasses RLS) sees or writes a row, whatever it is granted
CREATE POLICY owner_only ON core.rate_counter USING (false) WITH CHECK (false);
REVOKE ALL ON core.rate_counter FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- Windows longer than a day are refused, so a purge of rows older than two days never removes a
-- live window.
CREATE FUNCTION core.rate_hit(scope text, subject bytea, window_seconds int, max_hits int) RETURNS boolean
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
  INSERT INTO core.rate_counter AS rc (scope, subject, window_start, count)
  VALUES (rate_hit.scope, rate_hit.subject, w, 1)
  ON CONFLICT ON CONSTRAINT rate_counter_pkey
    DO UPDATE SET count = LEAST(rc.count, 1000000) + 1
  RETURNING rc.count INTO n;
  RETURN n <= max_hits;
END $$;
REVOKE ALL ON FUNCTION core.rate_hit(text, bytea, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.rate_hit(text, bytea, int, int) TO app_web, app_pay;

-- Deletes windows that started more than older_than ago (at least two days); returns how many.
CREATE FUNCTION core.rate_purge(older_than interval DEFAULT '2 days') RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n int;
BEGIN
  IF older_than IS NULL OR older_than < interval '2 days' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'older_than is at least two days');
  END IF;
  DELETE FROM core.rate_counter rc WHERE rc.window_start < clock_timestamp() - older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION core.rate_purge(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.rate_purge(interval) TO app_jobs;
