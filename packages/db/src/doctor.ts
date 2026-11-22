/**
 * Pre-flight and post-flight checks of a production database (Supabase), run by the owner with
 * `pnpm db:doctor` (scripts/db-doctor.ts). Read-only: every query runs in a READ ONLY transaction
 * that is rolled back. The report names objects, roles and settings only, never a secret, a
 * password, a connection string or a row of user data, so it is safe to share.
 *
 * Status: PASS (fine), FAIL (migrations or the app will not work, or a security property is
 * missing: fix before going live), WARN (works, but weaker than designed: read the detail), INFO.
 */
import type { ClientBase } from "pg";

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "INFO";

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

export const APP_SCHEMAS = [
  "core",
  "ledger",
  "private",
  "sandbox",
  "analytics",
  "audit",
  "research",
  "ops",
] as const;
export const PLATFORM_API_ROLES = ["anon", "authenticated", "service_role"] as const;
export const APP_LOGIN_ROLES = ["app_web", "app_pay", "app_jobs"] as const;

/** Columns of the sign-in service's tables that the migrations and core.actor_id() read. */
export const REQUIRED_AUTH_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ["id", "banned_until", "deleted_at", "phone", "phone_confirmed_at", "is_anonymous", "created_at"],
  sessions: ["id", "user_id", "not_after", "created_at"],
};

export interface DoctorOptions {
  /** Migration versions present in the repository (e.g. ["0001", ...]). */
  repositoryVersions: readonly string[];
}

export async function runDoctor(client: ClientBase, options: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => checks.push({ id, status, detail });
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await client.query<T>(sql, params)).rows;
  /** A query that may fail (an object that does not exist yet): [] then, the transaction intact. */
  const tryQ = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    await client.query("SAVEPOINT doctor_probe");
    try {
      const rows = await q<T>(sql, params);
      await client.query("RELEASE SAVEPOINT doctor_probe");
      return rows;
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT doctor_probe");
      return [];
    }
  };

  await client.query("BEGIN READ ONLY");
  try {
    // ------------------------------------------------------------ the connection itself
    const [me] = await q<{
      version: number;
      user: string;
      superuser: boolean;
      createrole: boolean;
      bypassrls: boolean;
      db: string;
      db_owner: string;
    }>(
      `SELECT current_setting('server_version_num')::int AS version, current_user AS user,
              r.rolsuper AS superuser, r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls,
              current_database() AS db, pg_get_userbyid(d.datdba) AS db_owner
         FROM pg_roles r, pg_database d WHERE r.rolname = current_user AND d.datname = current_database()`,
    );
    if (!me) throw new Error("could not read the connection's role");
    add(
      "postgres.version",
      me.version >= 150000 ? "PASS" : "FAIL",
      `server version ${Math.floor(me.version / 10000)} (15 or later needed)`,
    );
    add(
      "owner.createrole",
      me.superuser || me.createrole ? "PASS" : "FAIL",
      `connected as ${me.user}: ${me.superuser ? "superuser" : me.createrole ? "CREATEROLE (enough to create the app roles)" : "cannot create roles; connect as the project's postgres user"}`,
    );
    add(
      "owner.database_owner",
      me.db_owner === me.user || me.superuser ? "PASS" : "WARN",
      me.db_owner === me.user || me.superuser
        ? `database ${me.db} is owned by the connecting role`
        : `database ${me.db} is owned by ${me.db_owner}, not ${me.user}: migration 0001 cannot take TEMP/CREATE on the database away from PUBLIC (it only warns), so app roles could create temporary tables`,
    );

    // ------------------------------------------------------------ the sign-in service's schema
    const authSchema = await q<{ owner: string; usage: boolean }>(
      `SELECT pg_get_userbyid(n.nspowner) AS owner, has_schema_privilege(n.oid, 'USAGE') AS usage
         FROM pg_namespace n WHERE n.nspname = 'auth'`,
    );
    if (authSchema.length === 0) {
      add(
        "auth.schema",
        "WARN",
        "no schema auth: migration 0001 will create the LOCAL stand-in (not a Supabase project?)",
      );
    } else {
      add(
        "auth.schema",
        authSchema[0]?.usage ? "PASS" : "FAIL",
        `schema auth owned by ${authSchema[0]?.owner}; usage for ${me.user}: ${authSchema[0]?.usage ? "yes" : "NO"}`,
      );
      for (const [table, columns] of Object.entries(REQUIRED_AUTH_COLUMNS)) {
        const present = await q<{ column_name: string }>(
          `SELECT a.attname AS column_name FROM pg_attribute a
            WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
          [`auth.${table}`],
        );
        const names = new Set(present.map((r) => r.column_name));
        const missing = columns.filter((c) => !names.has(c));
        add(
          `auth.${table}.columns`,
          missing.length === 0 ? "PASS" : "FAIL",
          missing.length === 0 ? `has ${columns.join(", ")}` : `MISSING column(s): ${missing.join(", ")}`,
        );
      }
      const privileges = await q<{ table: string; sel: boolean; refs: boolean; del: boolean }>(
        `SELECT c.relname AS table, has_table_privilege(c.oid, 'SELECT') AS sel,
                has_table_privilege(c.oid, 'REFERENCES') AS refs, has_table_privilege(c.oid, 'DELETE') AS del
           FROM pg_class c WHERE c.relnamespace = 'auth'::regnamespace AND c.relname IN ('users', 'sessions')`,
      );
      const users = privileges.find((p) => p.table === "users");
      const sessions = privileges.find((p) => p.table === "sessions");
      add(
        "auth.read",
        users?.sel && sessions?.sel ? "PASS" : "FAIL",
        `SELECT on auth.users: ${users?.sel ? "yes" : "NO"}, auth.sessions: ${sessions?.sel ? "yes" : "NO"} (core.actor_id() reads both on every request)`,
      );
      add(
        "auth.users.references",
        users?.refs ? "PASS" : "FAIL",
        `REFERENCES on auth.users: ${users?.refs ? "yes" : "NO"} (core.user_profile.id references it, migration 0002)`,
      );
      add(
        "auth.sessions.delete",
        sessions?.del ? "PASS" : "WARN",
        sessions?.del
          ? "DELETE on auth.sessions: sign-out also deletes the sign-in service's session row"
          : "no DELETE on auth.sessions: sign-out still works (core.ended_session, 0071) but the row stays until Supabase removes it",
      );
      // Migrations 0001 and 0047 run REVOKE ... ON ALL TABLES / SEQUENCES IN SCHEMA auth; PostgreSQL
      // refuses that ("permission denied") for any object on which the owner holds no privilege.
      const noPrivilege = await q<{ object: string }>(
        `SELECT c.relname AS object FROM pg_class c
          WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND NOT (has_table_privilege(c.oid, 'SELECT') OR has_table_privilege(c.oid, 'INSERT')
                  OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE')
                  OR has_table_privilege(c.oid, 'REFERENCES') OR has_table_privilege(c.oid, 'TRIGGER')
                  OR has_table_privilege(c.oid, 'TRUNCATE'))
         UNION ALL
         SELECT c.relname FROM pg_class c
          WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind = 'S'
            AND NOT CASE WHEN c.relkind = 'S'
                         THEN has_sequence_privilege(c.oid, 'USAGE') OR has_sequence_privilege(c.oid, 'SELECT')
                              OR has_sequence_privilege(c.oid, 'UPDATE')
                         ELSE true END
          ORDER BY 1`,
      );
      add(
        "auth.revoke_possible",
        noPrivilege.length === 0 ? "PASS" : "FAIL",
        noPrivilege.length === 0
          ? "the owner holds a privilege on every auth table and sequence (the REVOKEs of migrations 0001 and 0047 can run)"
          : `no privilege at all on auth object(s) ${noPrivilege.map((r) => r.object).join(", ")}: migration 0001 or 0047 would fail with "permission denied"`,
      );
    }

    // ------------------------------------------------------------ extensions
    for (const ext of ["pgcrypto", "btree_gist"]) {
      const [row] = await q<{ installed: string | null; available: boolean }>(
        `SELECT (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1) AS installed,
                EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = $1) AS available`,
        [ext],
      );
      if (row?.installed) add(`extension.${ext}`, "PASS", `installed in schema ${row.installed}`);
      else if (row?.available)
        add(`extension.${ext}`, "INFO", "available, not installed yet (db:migrate:prod installs it)");
      else add(`extension.${ext}`, "FAIL", "not available on this server");
    }

    // ------------------------------------------------------------ the watchdog's needs (0021)
    const [mem] = await q<{ signal: boolean; stats: boolean }>(
      `SELECT pg_has_role('pg_signal_backend', 'MEMBER') AS signal, pg_has_role('pg_read_all_stats', 'MEMBER') AS stats`,
    );
    add(
      "owner.watchdog_roles",
      mem?.signal && mem.stats ? "PASS" : "WARN",
      `pg_signal_backend: ${mem?.signal ? "yes" : "no"}, pg_read_all_stats: ${mem?.stats ? "yes" : "no"} (without both the stuck-session watchdog cannot see or end other sessions)`,
    );

    // ------------------------------------------------------------ migrations
    const ledger = await tryQ<{ version: string }>("SELECT version FROM public.schema_migrations ORDER BY 1");
    const applied = new Set(ledger.map((r) => r.version));
    const pending = options.repositoryVersions.filter((v) => !applied.has(v));
    const unknown = [...applied].filter((v) => !options.repositoryVersions.includes(v));
    add(
      "migrations.pending",
      pending.length === 0 ? "PASS" : "INFO",
      pending.length === 0
        ? `all ${options.repositoryVersions.length} migrations applied`
        : `${pending.length} pending (${pending[0]} .. ${pending[pending.length - 1]}); run pnpm db:migrate:prod`,
    );
    if (unknown.length > 0) {
      add(
        "migrations.unknown",
        "WARN",
        `applied but not in this checkout: ${unknown.join(", ")} (an older checkout?)`,
      );
    }
    const migrated = applied.size > 0;

    // ------------------------------------------------------------ roles
    for (const role of APP_LOGIN_ROLES) {
      const [r] = await q<{
        login: boolean;
        super: boolean;
        bypass: boolean;
        createrole: boolean;
        createdb: boolean;
      }>(
        `SELECT rolcanlogin AS login, rolsuper AS super, rolbypassrls AS bypass, rolcreaterole AS createrole,
                rolcreatedb AS createdb FROM pg_roles WHERE rolname = $1`,
        [role],
      );
      if (!r) {
        add(
          `role.${role}`,
          migrated ? "FAIL" : "INFO",
          migrated ? "missing" : "not created yet (migration 0001 creates it)",
        );
      } else {
        const powers = [
          r.super && "SUPERUSER",
          r.bypass && "BYPASSRLS",
          r.createrole && "CREATEROLE",
          r.createdb && "CREATEDB",
        ].filter(Boolean);
        add(
          `role.${role}`,
          r.login && powers.length === 0 ? "PASS" : "FAIL",
          `${r.login ? "can log in" : "CANNOT log in (set its password with db:migrate:prod)"}${powers.length ? `; has ${powers.join(", ")}` : ""}`,
        );
      }
    }

    if (migrated) {
      // ---------------------------------------------------------- row-level security
      const noRls = await q<{ t: string }>(
        `SELECT c.oid::regclass::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1`,
        [[...APP_SCHEMAS]],
      );
      add(
        "rls.enabled",
        noRls.length === 0 ? "PASS" : "FAIL",
        noRls.length === 0
          ? "row-level security is on for every application table"
          : `RLS OFF on ${noRls.map((r) => r.t).join(", ")}`,
      );

      // ---------------------------------------------------------- the platform's API roles
      for (const role of PLATFORM_API_ROLES) {
        const exists = (await q(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).length > 0;
        if (!exists) {
          add(`api.${role}`, "INFO", "role does not exist here");
          continue;
        }
        const leaks = await q<{ what: string }>(
          `SELECT 'schema ' || n.nspname AS what FROM pg_namespace n
            WHERE n.nspname = ANY($2::text[]) AND has_schema_privilege($1, n.oid, 'USAGE')
           UNION ALL
           SELECT 'table ' || c.oid::regclass::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE (n.nspname = ANY($2::text[]) OR c.oid = to_regclass('public.schema_migrations'))
              AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
              AND (has_table_privilege($1, c.oid, 'SELECT') OR has_table_privilege($1, c.oid, 'INSERT')
                   OR has_table_privilege($1, c.oid, 'UPDATE') OR has_table_privilege($1, c.oid, 'DELETE'))
           LIMIT 20`,
          [role, [...APP_SCHEMAS]],
        );
        add(
          `api.${role}`,
          leaks.length === 0 ? "PASS" : "FAIL",
          leaks.length === 0
            ? "no access to any application schema or table, nor to public.schema_migrations"
            : `HAS ACCESS to ${leaks.map((l) => l.what).join(", ")} (run pnpm db:migrate:prod again; it revokes)`,
        );
      }

      // ---------------------------------------------------------- database-level privileges
      const temp = await q<{ role: string }>(
        `SELECT r AS role FROM unnest($1::text[]) r
          WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND has_database_privilege(r, current_database(), 'TEMP')`,
        [[...APP_LOGIN_ROLES]],
      );
      add(
        "database.temp",
        temp.length === 0 ? "PASS" : "WARN",
        temp.length === 0
          ? "application roles cannot create temporary tables"
          : `${temp.map((t) => t.role).join(", ")} can create temporary tables (PUBLIC still holds TEMP)`,
      );
      const advisory = await q<{ role: string }>(
        `SELECT r AS role FROM unnest($1::text[]) r
          WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
            AND has_function_privilege(r, 'pg_catalog.pg_advisory_lock(bigint)', 'EXECUTE')`,
        [[...APP_LOGIN_ROLES]],
      );
      add(
        "database.advisory_locks",
        advisory.length === 0 ? "PASS" : "WARN",
        advisory.length === 0
          ? "application roles cannot take advisory locks"
          : `${advisory.map((a) => a.role).join(", ")} can still take advisory locks (revoking needs a superuser; migration 0030's row locks and the watchdog cover it)`,
      );

      // ---------------------------------------------------------- deployment settings
      const settings = await tryQ<{ key: string; value: string }>(
        "SELECT key, value FROM core.deployment_setting ORDER BY key",
      );
      for (const s of settings) add(`setting.${s.key}`, "INFO", s.value);
      const [sms] = await tryQ<{ strict: boolean }>(
        "SELECT pg_get_functiondef('core.auth_phone_sms_confirmed(uuid)'::regprocedure) ~ 'phone_confirmed_at' AS strict",
      );
      if (sms) {
        add(
          "phone.sms_check",
          sms.strict ? "PASS" : "WARN",
          sms.strict
            ? "in 'sms' mode the database requires auth.users.phone_confirmed_at"
            : "the database TRUSTS the server that a phone was confirmed (no auth.users.phone_confirmed_at when 0070 ran)",
        );
      }
    }

    // ------------------------------------------------------------ the Data API's exposed schemas
    const pgrst = await tryQ<{ setting: string }>(
      `SELECT unnest(s.setconfig) AS setting FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
        WHERE r.rolname = 'authenticator'`,
    );
    const exposed =
      pgrst.find((s) => s.setting.startsWith("pgrst.db_schemas="))?.setting.split("=")[1] ?? null;
    if (exposed === null) {
      add(
        "api.exposed_schemas",
        "INFO",
        "no pgrst.db_schemas setting visible here; check the Data API settings in the dashboard",
      );
    } else {
      const list = exposed.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      const bad = list.filter((s) => (APP_SCHEMAS as readonly string[]).includes(s));
      add(
        "api.exposed_schemas",
        bad.length === 0 ? "PASS" : "FAIL",
        bad.length === 0
          ? `Data API exposes only: ${list.join(", ") || "(none)"}`
          : `Data API EXPOSES application schema(s): ${bad.join(", ")}`,
      );
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
  return checks;
}

/** One line per check, for the terminal. */
export function formatChecks(checks: readonly Check[]): string {
  return checks.map((c) => `${c.status.padEnd(4)}  ${c.id.padEnd(28)}  ${c.detail}`).join("\n");
}
