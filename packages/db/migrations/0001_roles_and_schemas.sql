-- LLD §2: database roles and schemas.
--
-- Production: migrations run as the dedicated owner role `migrator` (NOLOGIN; a
-- deploy identity is granted it for the migration step only). It owns every
-- object, so it is the only role that bypasses row-level security; the
-- application roles below own nothing, are never superuser and never BYPASSRLS
-- (tests/hardening.test.ts asserts this). Tests run migrations as the local
-- superuser, which is equivalent for ownership purposes.
--
-- Roles are cluster-wide. They are created when missing; when they already exist
-- they are ALTERed back to the intended attributes, so a role that drifted (or was
-- pre-created with extra powers) never keeps them silently. Passwords are set
-- outside migrations from the secret store.
DO $$
DECLARE
  r record;
  cur pg_roles%ROWTYPE;
  fix text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('migrator',      false, false, true),
      ('app_web',       true,  true,  true),
      -- money commands (provisioning, checkout, payment attempts, pay); a separate
      -- credential and pool from app_web, which is never a member of it (0011)
      ('app_pay',       true,  true,  true),
      ('app_jobs',      true,  true,  true),
      ('npc_worker',    true,  true,  true),
      ('research_ro',   true,  true,  true),
      -- managed-database built-in public roles; created here when missing so the
      -- REVOKE in the grants migration is valid and testable everywhere. On a managed
      -- platform they already exist and their attributes belong to the platform.
      ('anon',          false, true,  false),
      ('authenticated', false, true,  false)
    ) AS t(name, can_login, inherit, managed)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I %s %s', r.name,
                       CASE WHEN r.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END,
                       CASE WHEN r.inherit THEN 'INHERIT' ELSE 'NOINHERIT' END);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL; -- created concurrently by another migration run on the same cluster
      END;
    END IF;
    CONTINUE WHEN NOT r.managed;
    -- Existing role: reset every attribute that differs from the intended one. Only
    -- differing attributes are named, so an owner role without superuser can run this
    -- when nothing drifted, and fails loudly when it cannot remove a power.
    SELECT * INTO cur FROM pg_roles WHERE rolname = r.name;
    fix := concat_ws(' ',
      CASE WHEN cur.rolsuper       THEN 'NOSUPERUSER' END,
      CASE WHEN cur.rolcreatedb    THEN 'NOCREATEDB' END,
      CASE WHEN cur.rolcreaterole  THEN 'NOCREATEROLE' END,
      CASE WHEN cur.rolreplication THEN 'NOREPLICATION' END,
      CASE WHEN cur.rolbypassrls   THEN 'NOBYPASSRLS' END,
      CASE WHEN cur.rolcanlogin <> r.can_login THEN CASE WHEN r.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END END,
      CASE WHEN cur.rolinherit <> r.inherit THEN CASE WHEN r.inherit THEN 'INHERIT' ELSE 'NOINHERIT' END END);
    IF fix <> '' THEN
      EXECUTE format('ALTER ROLE %I %s', r.name, fix);
    END IF;
  END LOOP;
END $$;

-- app_web must never be able to SET ROLE app_pay (or inherit its privileges): drop
-- any membership of app_pay held by another application role, however it got there.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT r.rolname AS member
      FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid AND g.rolname = 'app_pay'
      JOIN pg_roles r ON r.oid = am.member
     WHERE r.rolname IN ('app_web', 'app_jobs', 'npc_worker', 'research_ro', 'anon', 'authenticated')
  LOOP
    EXECUTE format('REVOKE app_pay FROM %I', m.member);
  END LOOP;
END $$;

-- Session defaults for the application roles (security review, denial of service): a
-- connection logging in as one of them cannot sit idle inside a transaction holding locks
-- for more than 15 s, waits at most 2 s for a lock, and runs no statement longer than 10 s
-- (60 s for the job runner). Scoped to this database.
--
-- These are DEFAULTS. A role can override them for its own session or transaction with SET
-- (the data-access layer itself sets tighter transaction-local values, LLD §4), so they bound
-- accidents and simple abuse, not a determined holder of the credential. The definer
-- functions that lock other users' rows (ledger.sync_wallets, the commit-time checks of 0016)
-- carry their own lock_timeout, which a caller cannot raise.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES ('app_web', '10s'), ('app_pay', '10s'), ('app_jobs', '60s'), ('npc_worker', '10s'))
      AS t(name, statement_timeout)
  LOOP
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L',
                   r.name, current_database(), '15s');
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET lock_timeout = %L', r.name, current_database(), '2s');
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L',
                   r.name, current_database(), r.statement_timeout);
  END LOOP;
END $$;

-- No role but the owner creates objects or temporary tables in this database.
DO $$
BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro',
                 current_database());
END $$;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS ledger;
CREATE SCHEMA IF NOT EXISTS private;
CREATE SCHEMA IF NOT EXISTS sandbox;
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS research;

-- Nobody but the owner creates objects in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- Needed for the membership exclusion constraint (uuid WITH =).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Append-only guard shared by ledger.journal, ledger.posting, audit.audit_log
-- (and core.shipment_event, core.stock_movement when they are created).
CREATE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- =====================================================================================
-- Sign-in sessions (the acting user).
--
-- Production runs on Supabase, whose auth service owns the schema `auth`: users in
-- auth.users (id, banned_until, deleted_at, ...) and live sign-in sessions in auth.sessions
-- (id, user_id, not_after, created_at, updated_at, ...). The block below is a LOCAL / TEST
-- STAND-IN ONLY: it creates a minimal `auth` schema with exactly those two tables when, and
-- only when, no `auth` schema exists, so it is a no-op on Supabase. Nothing in this
-- repository writes auth.* except tests (as the owner), standing in for the auth service.
-- =====================================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (
      id           uuid PRIMARY KEY,
      banned_until timestamptz,
      deleted_at   timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE auth.sessions (
      id         uuid PRIMARY KEY,
      user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      not_after  timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sessions_user ON auth.sessions (user_id);
  END IF;
END $$;

-- Application roles get nothing on the auth schema: they cannot read users or sessions (a
-- session id is a bearer secret), let alone write them. Only core.actor_id() reads them.
REVOKE ALL ON SCHEMA auth FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC, app_web, app_pay, app_jobs, npc_worker, research_ro;

-- The acting user, derived from the sign-in session, never from a setting the connection
-- chooses. The data-access layer puts the caller's session id (a bearer secret from the
-- session cookie) in the transaction-local setting app.session_id; this function looks it up
-- in auth.sessions and returns its user only when the session is live (not_after unset or in
-- the future) and the user is neither banned nor deleted. Anything else - unset, malformed,
-- unknown, guessed, expired, banned, deleted - is NULL: no identity, so owner-scoped policies
-- match nothing and user-scoped commands refuse.
--
-- Background roles never act as a user: for app_jobs, npc_worker and research_ro the result
-- is NULL whatever session id they set. Inside this SECURITY DEFINER function current_user is
-- the owner, so the invoking role is read from the `role` setting (SET ROLE) or, without one,
-- the login (session_user); neither can be set to a role the connection is not a member of.
--
-- Session ids never appear in error messages, outbox payloads or stored results: this
-- function is the only code that reads app.session_id, and it never raises.
CREATE FUNCTION core.actor_id() RETURNS uuid
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
     AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
     AND u.deleted_at IS NULL;
  RETURN actor;
END $$;
-- There is deliberately no company setting either: company scope is derived from the acting
-- user in the database (core.actor_company_ids(), 0012).
