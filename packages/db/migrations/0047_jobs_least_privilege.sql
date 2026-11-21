-- The app_jobs credential (sixth security review, major 3). Holding the jobs login, the reviewer
-- changed any merchant coupon to 90% off, suspended any user (the Super Admin included), read every
-- user's fingerprints and bank aliases, and called the watchdog with max_age 1 second to kill live
-- transactions.
--
--  * app_jobs holds NO direct table, column or sequence privilege in any application schema, and
--    no USAGE on the schemas whose tables it used to read. Every job runs through a narrowly scoped
--    owner-run SECURITY DEFINER function and nothing else:
--      core.screening_pending(int), core.screening_apply(uuid, uuid, text, jsonb)   (0036)
--      core.moderation_safety_net()                                                  (0046)
--      core.rate_purge(interval), core.purge_idempotency_records()                   (0031, 0018)
--      ops.terminate_stuck_money_sessions(interval)                                  (here)
--    and the jobs endpoint's replay guard (0048). What app_jobs did by direct grant before
--    (tombstone retention, outbox relay, analytics aggregation, coupon and campaign upkeep, user
--    status changes) is not built as a job; each returns as its own definer function when it is.
--  * NOTE: core.screening_apply still TRUSTS THE JOBS PROCESS FOR THE VERDICT (OK / NEEDS_REVIEW /
--    REJECT) on the pinned revision. That is inherent to screening being done outside the
--    database: a holder of the jobs credential can approve a pending listing's text (never its
--    price, stock or anything another store owns), and can do nothing else listed above.
--  * The watchdog ignores any max_age below `watchdog_min_age_seconds` (5), and terminates only a
--    backend of an application login that holds a lock stronger than ACCESS SHARE (or an advisory
--    lock) AND, beyond that age, is either idle in a transaction or blocking another backend's lock
--    wait. A live transaction that is working and blocks nobody is never terminated.

-- ---------------------------------------------------------------- no direct privileges
REVOKE ALL ON ALL TABLES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research, ops, auth FROM app_jobs;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core, ledger, private, sandbox, analytics, audit, research, ops, auth FROM app_jobs;
REVOKE USAGE ON SCHEMA ledger, analytics, audit, private, sandbox, research, auth FROM app_jobs;

-- functions the jobs do not call
REVOKE EXECUTE ON FUNCTION core.identity_is_tombstoned(bytea, bytea), core.is_published_version(uuid),
  core.actor_company_ids() FROM app_jobs;

-- ---------------------------------------------------------------- the watchdog
CREATE OR REPLACE FUNCTION ops.terminate_stuck_money_sessions(max_age interval DEFAULT '5 seconds') RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  db_oid    oid := (SELECT d.oid FROM pg_database d WHERE d.datname = current_database());
  floor_age interval := make_interval(secs => core.config_int(core.current_config_id(),
                                                              ARRAY['watchdog_min_age_seconds'], 5));
  limit_age interval;
  r         record;
  n         int := 0;
BEGIN
  -- a shorter age than the floor is ignored: the floor applies
  limit_age := GREATEST(COALESCE(max_age, floor_age), floor_age);
  FOR r IN
    SELECT a.pid, a.usename::text AS login,
           clock_timestamp() - COALESCE(a.xact_start, a.backend_start) AS age,
           CASE WHEN a.state IN ('idle in transaction', 'idle in transaction (aborted)') THEN 'IDLE_IN_TRANSACTION'
                ELSE 'BLOCKING' END AS why,
           COALESCE(array_agg(DISTINCT l.relation::regclass::text ORDER BY l.relation::regclass::text)
                      FILTER (WHERE l.locktype = 'relation'), '{}') AS tables
      FROM pg_stat_activity a
      JOIN pg_roles who ON who.oid = a.usesysid
      JOIN pg_locks l ON l.pid = a.pid
     WHERE a.datname = current_database()
       AND a.pid <> pg_backend_pid()
       AND NOT who.rolsuper
       AND who.rolname <> current_user
       AND COALESCE(a.xact_start, a.backend_start) < clock_timestamp() - limit_age
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
       AND (
         -- idle inside its transaction for longer than the limit
         (a.state IN ('idle in transaction', 'idle in transaction (aborted)')
          AND a.state_change < clock_timestamp() - limit_age)
         -- or keeping another backend waiting for a lock
         OR EXISTS (SELECT 1 FROM pg_stat_activity w
                     WHERE w.datname = current_database() AND w.pid <> a.pid AND w.wait_event_type = 'Lock'
                       AND a.pid = ANY (pg_blocking_pids(w.pid)))
       )
     GROUP BY a.pid, a.usename, a.xact_start, a.backend_start, a.state
     ORDER BY COALESCE(a.xact_start, a.backend_start)
  LOOP
    -- waits (up to 2 s) until the backend has exited and released its locks
    CONTINUE WHEN NOT pg_terminate_backend(r.pid, 2000);
    n := n + 1;
    PERFORM audit.append_chained(NULL, 'SYSTEM', 'terminate_stuck_money_session', 'database_backend', r.pid::text,
      CASE r.why WHEN 'IDLE_IN_TRANSACTION' THEN 'backend sat idle in a transaction holding locks longer than the limit'
                 ELSE 'backend kept others waiting for its locks longer than the limit' END,
      jsonb_build_object('pid', r.pid, 'role', r.login,
                         'transactionAgeSeconds', round(extract(epoch FROM r.age)::numeric, 1),
                         'maxAgeSeconds', extract(epoch FROM limit_age), 'tables', to_jsonb(r.tables)));
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION ops.terminate_stuck_money_sessions(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.terminate_stuck_money_sessions(interval) TO app_jobs;

COMMENT ON FUNCTION core.screening_apply(uuid, uuid, text, jsonb) IS
  'Applies the screening verdict of the jobs process to the pinned revision. The verdict itself is trusted: '
  'screening runs outside the database, so the jobs credential can approve pending listing text, and nothing else.';
