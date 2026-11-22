/**
 * pnpm db:doctor — read-only checks of the production database BEFORE and AFTER migrating.
 * Prints PASS / FAIL / WARN / INFO lines. The output contains no secret and is SAFE TO SHARE.
 *
 *   DATABASE_CA_CERT_FILE=~/Downloads/prod-ca-2021.crt pnpm db:doctor
 * It asks for the owner connection string and its password at prompts that do not echo (or reads
 * DATABASE_URL_OWNER, with or without the password, from this terminal).
 *
 * Optional, to test the application logins too (the same values you give Vercel):
 *   DATABASE_URL_WEB, DATABASE_URL_PAY, DATABASE_URL_JOBS
 * Optional, to check that the Data API does not serve application tables:
 *   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY
 */
import { type Check, formatChecks, runDoctor } from "../packages/db/src/doctor.ts";
import { listMigrations } from "../packages/db/src/migrate.ts";
import { parseOwnerTarget } from "../packages/db/src/prod-tools.ts";
import { describeTarget, explain, ownerPool, ownerTarget, say } from "./lib/owner-terminal.ts";

async function loginChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [name, role] of [
    ["DATABASE_URL_WEB", "app_web"],
    ["DATABASE_URL_PAY", "app_pay"],
    ["DATABASE_URL_JOBS", "app_jobs"],
  ] as const) {
    const url = process.env[name];
    if (!url) {
      checks.push({ id: `login.${role}`, status: "INFO", detail: `${name} not set here; login not tested` });
      continue;
    }
    const target = parseOwnerTarget(url);
    const pool = ownerPool(url, target);
    try {
      const c = await pool.connect();
      try {
        const { rows } = await c.query<{ who: string; st: string }>(
          "SELECT session_user AS who, current_setting('statement_timeout') AS st",
        );
        const who = rows[0]?.who ?? "";
        const ok = who === role;
        checks.push({
          id: `login.${role}`,
          status: ok ? "PASS" : "FAIL",
          detail: ok
            ? `logs in as ${who} via ${target.kind} (statement_timeout ${rows[0]?.st})${target.kind === "pooler-transaction" ? "" : "; Vercel should use the transaction pooler, port 6543"}`
            : `logs in as ${who}, expected ${role}`,
        });
      } finally {
        c.release();
      }
    } catch (error) {
      checks.push({ id: `login.${role}`, status: "FAIL", detail: explain(error) });
    } finally {
      await pool.end();
    }
  }
  return checks;
}

async function dataApiCheck(): Promise<Check[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    return [
      {
        id: "api.http",
        status: "INFO",
        detail: "SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set here; Data API not probed",
      },
    ];
  const checks: Check[] = [];
  for (const table of ["user_profile", "wallet", "schema_migrations"]) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: key, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const readable = response.status === 200;
      checks.push({
        id: `api.http.${table}`,
        status: readable ? "FAIL" : "PASS",
        detail: readable
          ? "the Data API RETURNED rows or an empty list: it can read this table"
          : `refused (HTTP ${response.status})`,
      });
    } catch {
      checks.push({ id: `api.http.${table}`, status: "WARN", detail: "could not reach the Data API" });
    }
  }
  return checks;
}

async function main(): Promise<void> {
  const { url, target } = await ownerTarget({ requireConfirm: false });
  say(`db:doctor: ${describeTarget(target)}`);
  if (target.kind === "pooler-transaction")
    say("Note: use the Session pooler (port 5432) or the direct connection for the owner.");
  const pool = ownerPool(url, target);
  let checks: Check[];
  try {
    const c = await pool.connect();
    try {
      checks = await runDoctor(c, { repositoryVersions: (await listMigrations()).map((m) => m.version) });
    } finally {
      c.release();
    }
  } catch (error) {
    await pool.end();
    say(`FAIL  connection                    ${explain(error)}`);
    process.exit(1);
  }
  await pool.end();
  checks.push(...(await loginChecks()), ...(await dataApiCheck()));
  process.stdout.write(`${formatChecks(checks)}\n`);
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const warned = checks.filter((c) => c.status === "WARN").length;
  say(`\n${failed} FAIL, ${warned} WARN. This output contains no secrets: it is safe to share.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  say(`db:doctor failed: ${explain(error)}`);
  process.exit(1);
});
