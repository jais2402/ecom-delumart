-- Advisory-lock denial of service (fifth security review).
--
-- Advisory locks are cluster-visible keys anyone with EXECUTE on pg_advisory_lock can take. The
-- per-actor serialisation of 0018/0020/0028 (core.lock_actor) and the audit hash chain (0021)
-- used predictable keys (hashtextextended('core.cart_line:' || user_id, 0), ...), so an
-- application login could take a victim's key with a SESSION-level pg_advisory_lock, sit idle
-- outside any transaction (no idle_in_transaction timeout applies, and the watchdog looked only at
-- transactions) and block the victim's cart, checkout and coupon calls indefinitely.
--
--  (a) core.lock_actor now locks a ROW: core.actor_lock (kind, subject), created on first use,
--      locked FOR UPDATE inside the definer functions. No application role holds any privilege on
--      the table, so only owner-defined functions can take or wait for these locks, and a row lock
--      always ends with its transaction. As defence in depth, EXECUTE on every pg_advisory_*
--      function is revoked from PUBLIC and the application roles (the owner keeps it: the
--      migration runner serialises migrations on one). A non-superuser owner cannot revoke
--      privileges on pg_catalog functions (REVOKE then only warns): there (c) still applies.
--  (b) The audit hash chain serialises on a single owner-only head row (audit.chain_head) instead
--      of an advisory key; audit.append_chained is the one chained writer.
--  (c) ops.terminate_stuck_money_sessions also ends backends of application roles (by login name
--      or by membership, so a login that is a member of app_web or app_pay is covered) that hold
--      an advisory lock, or any lock stronger than ACCESS SHARE in this database, for longer than
--      max_age, whether or not they are inside a transaction (the age of a session-level advisory
--      lock is bounded by the age of its connection).

-- ---------------------------------------------------------------- (a) per-actor row locks
CREATE TABLE core.actor_lock (
  kind    text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_]+$'),
  subject uuid NOT NULL,
  PRIMARY KEY (kind, subject)
);
ALTER TABLE core.actor_lock ENABLE ROW LEVEL SECURITY;
-- no role but the owner (which bypasses RLS) sees or writes a row, whatever it is granted
CREATE POLICY owner_only ON core.actor_lock USING (false) WITH CHECK (false);
REVOKE ALL ON core.actor_lock FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- Serialises the caller's transaction with every other transaction of the same kind for the same
-- subject (an actor, or a company for coupons); released at commit or rollback. Callers are the
-- owner's definer functions; no application role may execute it.
CREATE OR REPLACE FUNCTION core.lock_actor(kind text, actor uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF kind IS NULL OR actor IS NULL THEN
    RAISE EXCEPTION 'lock_actor needs a kind and a subject' USING ERRCODE = 'null_value_not_allowed';
  END IF;
  INSERT INTO core.actor_lock (kind, subject) VALUES (lock_actor.kind, lock_actor.actor) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM core.actor_lock al WHERE al.kind = lock_actor.kind AND al.subject = lock_actor.actor FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION core.lock_actor(text, uuid) FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- Nobody but the owner takes advisory locks in this database.
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p
     WHERE p.pronamespace = 'pg_catalog'::regnamespace
       AND p.proname IN ('pg_advisory_lock', 'pg_advisory_lock_shared', 'pg_advisory_unlock',
                         'pg_advisory_unlock_shared', 'pg_advisory_unlock_all', 'pg_advisory_xact_lock',
                         'pg_advisory_xact_lock_shared', 'pg_try_advisory_lock', 'pg_try_advisory_lock_shared',
                         'pg_try_advisory_xact_lock', 'pg_try_advisory_xact_lock_shared')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, current_user);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- (b) audit chain head
-- One row: the row_hash of the last chained audit row. Locked FOR UPDATE by every chained append,
-- so appends are strictly ordered and each links to the one before it (LLD §11.4).
CREATE TABLE audit.chain_head (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  row_hash  bytea
);
ALTER TABLE audit.chain_head ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON audit.chain_head USING (false) WITH CHECK (false);
REVOKE ALL ON audit.chain_head FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;
INSERT INTO audit.chain_head (id, row_hash)
VALUES (true, (SELECT l.row_hash FROM audit.audit_log l ORDER BY l.id DESC LIMIT 1));

-- Appends one chained audit row: row_hash = SHA-256(prev_hash || canonical row). Owner only.
CREATE FUNCTION audit.append_chained(actor_id uuid, actor_kind text, action text, target_type text,
                                     target_id text, reason text, detail jsonb) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev bytea;
  at   timestamptz;
  hash bytea;
  new_id bigint;
BEGIN
  SELECT h.row_hash INTO prev FROM audit.chain_head h WHERE h.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit chain head is missing' USING ERRCODE = 'no_data_found';
  END IF;
  at := clock_timestamp();
  hash := sha256(COALESCE(prev, ''::bytea) || convert_to(jsonb_build_object(
            'actor_id', append_chained.actor_id, 'actor_kind', append_chained.actor_kind,
            'action', append_chained.action, 'target_type', append_chained.target_type,
            'target_id', append_chained.target_id, 'reason', append_chained.reason,
            'detail', append_chained.detail, 'created_at', at)::text, 'UTF8'));
  INSERT INTO audit.audit_log (actor_id, actor_kind, action, target_type, target_id, reason, detail, prev_hash,
                               row_hash, created_at)
  VALUES (append_chained.actor_id, append_chained.actor_kind, append_chained.action, append_chained.target_type,
          append_chained.target_id, append_chained.reason, append_chained.detail, prev, hash, at)
  RETURNING id INTO new_id;
  UPDATE audit.chain_head h SET row_hash = hash WHERE h.id;
  RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION audit.append_chained(uuid, text, text, text, text, text, jsonb)
  FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- ---------------------------------------------------------------- (c) the watchdog
CREATE OR REPLACE FUNCTION ops.terminate_stuck_money_sessions(max_age interval DEFAULT '5 seconds') RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  db_oid  oid := (SELECT d.oid FROM pg_database d WHERE d.datname = current_database());
  r       record;
  n       int := 0;
BEGIN
  IF max_age IS NULL OR max_age < interval '1 second' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'max_age is at least one second');
  END IF;
  FOR r IN
    SELECT a.pid, a.usename::text AS login,
           clock_timestamp() - COALESCE(a.xact_start, a.backend_start) AS age,
           COALESCE(array_agg(DISTINCT l.relation::regclass::text ORDER BY l.relation::regclass::text)
                      FILTER (WHERE l.locktype = 'relation'), '{}') AS tables
      FROM pg_stat_activity a
      JOIN pg_roles who ON who.oid = a.usesysid
      JOIN pg_locks l ON l.pid = a.pid
     WHERE a.datname = current_database()
       AND a.pid <> pg_backend_pid()
       AND NOT who.rolsuper
       AND who.rolname <> current_user
       AND COALESCE(a.xact_start, a.backend_start) < clock_timestamp() - max_age
       AND l.granted
       AND (
         -- advisory locks: no application role may hold one at all (only owner functions take them)
         (l.locktype = 'advisory'
          AND (pg_has_role(who.oid, 'app_web', 'MEMBER') OR pg_has_role(who.oid, 'app_pay', 'MEMBER')
               OR pg_has_role(who.oid, 'app_jobs', 'MEMBER') OR pg_has_role(who.oid, 'npc_worker', 'MEMBER')
               OR pg_has_role(who.oid, 'research_ro', 'MEMBER')))
         -- row locks and writes of the web and pay logins (their transactions last well under a second)
         OR (l.locktype IN ('relation', 'tuple') AND l.database = db_oid AND l.mode <> 'AccessShareLock'
             AND (pg_has_role(who.oid, 'app_web', 'MEMBER') OR pg_has_role(who.oid, 'app_pay', 'MEMBER')))
       )
     GROUP BY a.pid, a.usename, a.xact_start, a.backend_start
     ORDER BY COALESCE(a.xact_start, a.backend_start)
  LOOP
    -- waits (up to 2 s) until the backend has exited and released its locks
    CONTINUE WHEN NOT pg_terminate_backend(r.pid, 2000);
    n := n + 1;
    PERFORM audit.append_chained(NULL, 'SYSTEM', 'terminate_stuck_money_session', 'database_backend', r.pid::text,
      'backend held locks longer than the limit',
      jsonb_build_object('pid', r.pid, 'role', r.login,
                         'transactionAgeSeconds', round(extract(epoch FROM r.age)::numeric, 1),
                         'maxAgeSeconds', extract(epoch FROM max_age), 'tables', to_jsonb(r.tables)));
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION ops.terminate_stuck_money_sessions(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.terminate_stuck_money_sessions(interval) TO app_jobs;
