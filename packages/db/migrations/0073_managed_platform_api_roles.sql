-- The managed platform's API roles get nothing (architecture §9.1.2, "Supabase-specific hardening").
--
-- Supabase serves an auto-generated REST/GraphQL API (the Data API) as the roles anon (no sign-in),
-- authenticated (a Supabase user's token) and service_role (the secret key), and its default
-- privileges grant those roles access to new objects in some schemas. This application never uses
-- that API: it talks to Postgres only from its own server code, as app_web, app_pay and app_jobs.
-- ops.revoke_platform_api_roles() removes every privilege those three roles hold on the
-- application's schemas, their tables, sequences and functions, and on the migration ledger
-- (public.schema_migrations), and removes the owner's default privileges for them in the
-- application schemas. Roles that do not exist (local development has no service_role) are
-- skipped. It is idempotent; `pnpm db:migrate:prod` runs it again after every migration run, so
-- objects added by later migrations are covered too. Owner-only.
--
-- This is defence in depth: the Data API should also be switched off, or no application schema
-- exposed (docs/deploy-runbook.md), and row-level security is on for every table (0012).

CREATE FUNCTION ops.revoke_platform_api_roles() RETURNS int
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r       text;
  s       text;
  revoked int := 0;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    FOREACH s IN ARRAY ARRAY['core', 'ledger', 'private', 'sandbox', 'analytics', 'audit', 'research', 'ops'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s);
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s, r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', s, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', s, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', s, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I', s, r);
    END LOOP;
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.schema_migrations FROM %I', r);
    END IF;
    revoked := revoked + 1;
  END LOOP;
  RETURN revoked;
END $$;
REVOKE ALL ON FUNCTION ops.revoke_platform_api_roles() FROM PUBLIC;

SELECT ops.revoke_platform_api_roles();
