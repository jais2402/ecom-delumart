-- LLD §2: database roles and schemas.
-- Roles are cluster-wide, so they are created idempotently. Passwords are set
-- outside migrations from the secret store.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('migrator',      'NOLOGIN NOINHERIT'),
      ('app_web',       'LOGIN'),
      ('app_jobs',      'LOGIN'),
      ('npc_worker',    'LOGIN'),
      ('research_ro',   'LOGIN'),
      -- managed-database built-in public roles; created here when missing so the
      -- REVOKE in the grants migration is valid and testable everywhere
      ('anon',          'NOLOGIN'),
      ('authenticated', 'NOLOGIN')
    ) AS t(name, opts)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I %s', r.name, r.opts);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL; -- created concurrently by another migration run on the same cluster
      END;
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS ledger;
CREATE SCHEMA IF NOT EXISTS private;
CREATE SCHEMA IF NOT EXISTS sandbox;
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS research;

-- Nobody but the owner creates objects in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Needed for the membership exclusion constraint (uuid WITH =).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Append-only guard shared by ledger.journal, ledger.posting, audit.audit_log
-- (and core.shipment_event, core.stock_movement when they are created).
CREATE FUNCTION audit.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
