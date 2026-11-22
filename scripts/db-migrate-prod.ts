/**
 * pnpm db:migrate:prod --confirm <project-ref> — applies the pending migrations to the production
 * database, from the owner's own terminal.
 *
 *   DATABASE_CA_CERT_FILE=~/Downloads/prod-ca-2021.crt pnpm db:migrate:prod --confirm <project-ref>
 *
 * It asks (prompts that do not echo) for the owner connection string and its password, and for the
 * three login passwords APP_WEB_PASSWORD, APP_PAY_PASSWORD, APP_JOBS_PASSWORD (empty: unchanged),
 * unless they are in this terminal's environment; with --yes nothing is asked.
 *
 * 1. refuses unless --confirm names the project in DATABASE_URL_OWNER (and never on Vercel);
 * 2. prints the plan (the pending migrations) and asks you to type the project ref again
 *    (or pass --yes when not in an interactive terminal);
 * 3. installs btree_gist and pgcrypto in the `extensions` schema when that schema exists (Supabase);
 * 4. applies each migration in its own transaction (a failure rolls that one back and stops);
 * 5. revokes everything the platform's API roles (anon, authenticated, service_role) hold on the
 *    application's objects (ops.revoke_platform_api_roles());
 * 6. sets the login passwords of app_web, app_pay and app_jobs from APP_WEB_PASSWORD,
 *    APP_PAY_PASSWORD and APP_JOBS_PASSWORD when given (as SCRAM verifiers computed here: the
 *    password never reaches the server or its logs, and is never printed);
 * 7. runs the doctor's checks.
 */
import { formatChecks, runDoctor } from "../packages/db/src/doctor.ts";
import { listMigrations, migrate } from "../packages/db/src/migrate.ts";
import { scramSha256Verifier, strongPassword } from "../packages/db/src/prod-tools.ts";
import {
  ask,
  describeTarget,
  explain,
  fail,
  hasFlag,
  ownerPool,
  ownerTarget,
  say,
} from "./lib/owner-terminal.ts";

const ROLE_PASSWORDS = [
  ["app_web", "APP_WEB_PASSWORD"],
  ["app_pay", "APP_PAY_PASSWORD"],
  ["app_jobs", "APP_JOBS_PASSWORD"],
] as const;

async function main(): Promise<void> {
  const { url, target } = await ownerTarget({ requireConfirm: true });
  // the login passwords: from this terminal's environment, or typed at prompts that do not echo
  if (!hasFlag("--yes") && process.stdin.isTTY) {
    for (const [role, variable] of ROLE_PASSWORDS) {
      if (process.env[variable] !== undefined) continue;
      const typed = await ask(
        `${variable} for ${role} (not shown; leave empty to keep the current password): `,
        true,
      );
      if (typed !== "") process.env[variable] = typed;
    }
  }
  for (const [, variable] of ROLE_PASSWORDS) {
    const value = process.env[variable];
    if (value !== undefined && !strongPassword(value)) {
      fail(`${variable} must be 24-128 printable ASCII characters (generate one: openssl rand -hex 24).`);
    }
  }
  const pool = ownerPool(url, target);
  try {
    const all = await listMigrations();
    const applied = new Set(
      (
        await pool
          .query<{ version: string }>(
            "SELECT version FROM public.schema_migrations WHERE to_regclass('public.schema_migrations') IS NOT NULL",
          )
          .catch(async () => ({ rows: [] as { version: string }[] }))
      ).rows.map((r) => r.version),
    );
    const pending = all.filter((m) => !applied.has(m.version));
    say(`db:migrate:prod: ${describeTarget(target)}`);
    say(
      pending.length === 0 ? "Plan: no pending migrations." : `Plan: apply ${pending.length} migration(s):`,
    );
    for (const m of pending) say(`  ${m.name}`);
    const passwords = ROLE_PASSWORDS.filter(([, v]) => process.env[v] !== undefined).map(([role]) => role);
    say(
      passwords.length
        ? `Then set the login password of: ${passwords.join(", ")}`
        : "No role passwords given (APP_*_PASSWORD): passwords unchanged.",
    );
    if (!hasFlag("--yes")) {
      const typed = await ask("Type the project ref again to go ahead: ");
      if (typed !== (target.loopback ? "local" : target.projectRef))
        fail("Not confirmed. Nothing was changed.");
    }

    const extensions = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = 'extensions'");
    if (extensions.rowCount) {
      for (const ext of ["btree_gist", "pgcrypto"]) {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext} WITH SCHEMA extensions`);
      }
    }
    const result = await migrate(pool);
    for (const name of result.applied) say(`  applied ${name}`);
    say(`${result.applied.length} applied, ${result.skipped.length} already applied.`);
    const revoked = await pool.query<{ n: number }>("SELECT ops.revoke_platform_api_roles() AS n");
    say(`Platform API roles cleared (${revoked.rows[0]?.n ?? 0} role(s) present).`);

    for (const [role, variable] of ROLE_PASSWORDS) {
      const password = process.env[variable];
      if (password === undefined) continue;
      const c = await pool.connect();
      try {
        // role names come from the fixed list above; the verifier is escaped as a literal
        await c.query(`ALTER ROLE ${role} LOGIN PASSWORD ${c.escapeLiteral(scramSha256Verifier(password))}`);
      } finally {
        c.release();
      }
      say(`Password set for ${role}.`);
    }

    const c = await pool.connect();
    try {
      const checks = await runDoctor(c, { repositoryVersions: all.map((m) => m.version) });
      process.stdout.write(`${formatChecks(checks)}\n`);
      const failed = checks.filter((k) => k.status === "FAIL").length;
      say(`\nDone. ${failed} FAIL. This output contains no secrets: it is safe to share.`);
      if (failed > 0) process.exitCode = 1;
    } finally {
      c.release();
    }
  } catch (error) {
    say(`db:migrate:prod stopped: ${explain(error)}`);
    say(
      "Each migration runs in its own transaction: the failed one changed nothing; earlier ones stay applied.",
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  say(`db:migrate:prod failed: ${explain(error)}`);
  process.exit(1);
});
