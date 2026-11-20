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

-- No role but the owner creates objects or temporary tables in this database.
DO $$
BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, app_web, app_jobs, npc_worker, research_ro',
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
REVOKE CREATE ON SCHEMA public FROM PUBLIC, app_web, app_jobs, npc_worker, research_ro;

-- Needed for the membership exclusion constraint (uuid WITH =).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Append-only guard shared by ledger.journal, ledger.posting, audit.audit_log
-- (and core.shipment_event, core.stock_movement when they are created).
CREATE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- Row-level security context, set transaction-locally by the data-access layer.
-- Unset or empty settings read as NULL, so a request without them matches no rows.
CREATE FUNCTION core.app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
CREATE FUNCTION core.app_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;
