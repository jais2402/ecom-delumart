-- Lock-holding denial of service (fourth security review).
--
-- An app_pay (or app_web) session can run a money command to completion, raise its own
-- idle_in_transaction_session_timeout and statement_timeout (they are session defaults, 0001),
-- and never commit: it then keeps the seller's wallet, product, warehouse and coupon rows locked,
-- and every other buyer of that seller gets BUSY for as long as it likes. Settlement is not
-- redesigned for this; instead a watchdog ends such sessions.
--
-- ops.terminate_stuck_money_sessions(max_age) terminates every backend whose LOGIN (session
-- user) is app_pay or app_web, that has been inside one transaction for longer than max_age, and
-- that holds a lock stronger than ACCESS SHARE (a row lock or a write) on a money table. It
-- returns how many it terminated and writes one audit.audit_log row per termination (actor_kind
-- SYSTEM; backend pid, login role, ages and table names only: no personal data, no query text).
-- A terminated backend's transaction rolls back: nothing of it commits, and the victims' retries
-- with the same idempotency key go through.
--
-- Production schedules it every few seconds (job runner, app_jobs). It BOUNDS the attack (to
-- max_age plus the schedule interval per attempt, and each attempt costs the attacker a
-- connection) rather than eliminating it. Money transactions legitimately last well under a
-- second (LLD §4: 2 s lock and 5 s statement timeouts), so the default max_age of 5 seconds
-- ends none of them.
--
-- The function runs as the owner. pg_terminate_backend on another role's backend needs
-- pg_signal_backend, and reading other sessions' xact_start needs pg_read_all_stats: in
-- production the owner (migrator) must hold both (a superuser, as in tests, has them).

CREATE SCHEMA IF NOT EXISTS ops;
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO app_jobs;
ALTER DEFAULT PRIVILEGES IN SCHEMA ops REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE FUNCTION ops.terminate_stuck_money_sessions(max_age interval DEFAULT '5 seconds') RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  money   oid[] := ARRAY(SELECT to_regclass(t)::oid FROM unnest(ARRAY[
    'ledger.ledger_account', 'ledger.journal', 'ledger.posting', 'ledger.wallet', 'ledger.grant_record',
    'ledger.journal_seal', 'core.checkout_session', 'core.payment_attempt', 'core.payment_challenge',
    'core.idempotency_record', 'core.order_group', 'core.order_group_seal', 'core.seller_order',
    'core.order_line', 'core.ownership', 'core.shipment', 'core.coupon', 'core.coupon_redemption',
    'core.promo_campaign', 'core.membership', 'core.company', 'core.warehouse', 'core.product',
    'core.inventory_unit', 'core.bank_account', 'core.virtual_card', 'core.creator_entitlement',
    'core.system_switch']) t WHERE to_regclass(t) IS NOT NULL);
  db_oid  oid := (SELECT d.oid FROM pg_database d WHERE d.datname = current_database());
  r       record;
  n       int := 0;
  prev    bytea;
  at      timestamptz;
  detail  jsonb;
  reason  text;
BEGIN
  IF max_age IS NULL OR max_age < interval '1 second' THEN
    PERFORM core.fail('VALIDATION_FAILED', 'max_age is at least one second');
  END IF;
  FOR r IN
    SELECT a.pid, a.usename::text AS login, clock_timestamp() - a.xact_start AS age,
           array_agg(DISTINCT l.relation::regclass::text ORDER BY l.relation::regclass::text) AS tables
      FROM pg_stat_activity a
      JOIN pg_locks l ON l.pid = a.pid
     WHERE a.usename IN ('app_pay', 'app_web')
       AND a.datname = current_database()
       AND a.pid <> pg_backend_pid()
       AND a.xact_start IS NOT NULL
       AND a.xact_start < clock_timestamp() - max_age
       AND l.locktype = 'relation' AND l.database = db_oid AND l.granted
       AND l.mode <> 'AccessShareLock'
       AND l.relation = ANY (money)
     GROUP BY a.pid, a.usename, a.xact_start
     ORDER BY a.xact_start
  LOOP
    -- waits (up to 2 s) until the backend has exited and released its locks
    CONTINUE WHEN NOT pg_terminate_backend(r.pid, 2000);
    n := n + 1;
    -- audit hash chain (LLD §11.4): row_hash = SHA-256(prev_hash || canonical row)
    PERFORM pg_advisory_xact_lock(hashtextextended('audit.audit_log:chain', 0));
    SELECT l.row_hash INTO prev FROM audit.audit_log l ORDER BY l.id DESC LIMIT 1;
    at := clock_timestamp();
    detail := jsonb_build_object('pid', r.pid, 'role', r.login,
                                 'transactionAgeSeconds', round(extract(epoch FROM r.age)::numeric, 1),
                                 'maxAgeSeconds', extract(epoch FROM max_age), 'tables', to_jsonb(r.tables));
    reason := 'transaction held money-table locks longer than the limit';
    INSERT INTO audit.audit_log (actor_id, actor_kind, action, target_type, target_id, reason, detail, prev_hash,
                                 row_hash, created_at)
    VALUES (NULL, 'SYSTEM', 'terminate_stuck_money_session', 'database_backend', r.pid::text, reason, detail, prev,
            sha256(COALESCE(prev, ''::bytea) || convert_to(jsonb_build_object(
              'actor_id', NULL, 'actor_kind', 'SYSTEM', 'action', 'terminate_stuck_money_session',
              'target_type', 'database_backend', 'target_id', r.pid::text, 'reason', reason, 'detail', detail,
              'created_at', at)::text, 'UTF8')),
            at);
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION ops.terminate_stuck_money_sessions(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.terminate_stuck_money_sessions(interval) TO app_jobs;
