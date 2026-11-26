/**
 * Local development only: makes the Super Admin's waiting delayed actions due now, runs the jobs
 * once, and lets the configuration version they created take effect now, as if 24 hours and the
 * grace period had passed (migration 0090, docs/decisions.md #16). The browser journey
 * tests/e2e/admin-actions.spec.mjs runs it; there is no route for it in the app and no application
 * role can do it: it connects as the database owner.
 *
 *     DEV_DB_NAME=delulu_dev BASE_URL=http://localhost:3000 pnpm dev:expedite-admin-actions
 *
 * Refuses anything but a database and a server on this machine (localhost, 127.x, ::1), and refuses
 * to run when NODE_ENV is production. The jobs call is the real, signed POST /api/internal/jobs/run
 * with JOBS_SIGNING_KEY from apps/web/.env.local.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isLoopbackHost } from "../packages/db/src/connection.ts";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pg = require("pg") as typeof import("pg");
// pg's own parser (a dependency of pg), resolved from pg's location
const { parse: parseConnectionString } = createRequire(require.resolve("pg"))(
  "pg-connection-string",
) as typeof import("pg-connection-string");

if (process.env.NODE_ENV === "production")
  throw new Error("dev:expedite-admin-actions is for development only");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const DB_NAME = process.env.DEV_DB_NAME ?? "delulu_dev";
const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(DB_NAME))
  throw new Error("DEV_DB_NAME must be a plain lowercase identifier");
// The libpq environment can override any host in a URL: refuse it outright.
for (const name of ["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"]) {
  if (process.env[name] !== undefined)
    throw new Error(`${name} must not be set for dev:expedite-admin-actions`);
}
// A query string can carry host= or hostaddr= (pg-connection-string lets it override the URL's host).
if (new URL(ADMIN_URL).search !== "")
  throw new Error("DATABASE_URL must have no query string here; local database only");
// What the driver would use, parsed the way pg parses it, and then passed on as explicit fields.
const parsed = parseConnectionString(ADMIN_URL);
const dbHost = parsed.host ?? "";
if (!(isLoopbackHost(dbHost) || dbHost.startsWith("/")))
  throw new Error("dev:expedite-admin-actions runs against a local database only");
if (!isLoopbackHost(new URL(BASE_URL).hostname))
  throw new Error("dev:expedite-admin-actions calls a local server only");

function jobsKey(): Buffer {
  const text = readFileSync(new URL("../apps/web/.env.local", import.meta.url), "utf8");
  const match = /^JOBS_SIGNING_KEY=([0-9a-f]+)$/im.exec(text);
  if (!match?.[1]) throw new Error("JOBS_SIGNING_KEY is not in apps/web/.env.local (run pnpm dev:setup)");
  return Buffer.from(match[1], "hex");
}

const client = new pg.Client({
  host: dbHost,
  port: parsed.port ? Number(parsed.port) : 5432,
  ...(parsed.user ? { user: parsed.user } : {}),
  ...(parsed.password ? { password: parsed.password } : {}),
  database: DB_NAME,
});
await client.connect();
try {
  // belt and braces: the server reached is on this machine (a unix socket reports NULL)
  const where = await client.query<{ a: string | null }>("SELECT host(inet_server_addr()) AS a");
  const addr = where.rows[0]?.a ?? null;
  if (addr !== null && !isLoopbackHost(addr))
    throw new Error("dev:expedite-admin-actions runs against a local database only");
  const due = await client.query(
    `UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE state = 'QUEUED'`,
  );
  process.stderr.write(
    `[dev:expedite-admin-actions] ${due.rowCount ?? 0} waiting action(s) in ${DB_NAME} made due\n`,
  );

  const body = "{}";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", jobsKey()).update(`${timestamp}.${body}`).digest("hex");
  const response = await fetch(`${BASE_URL}/api/internal/jobs/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-delulu-timestamp": timestamp,
      "x-delulu-signature": signature,
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`the jobs run answered ${response.status}`);
  const report = JSON.parse(text) as { report?: { adminActions?: unknown } };
  process.stderr.write(
    `[dev:expedite-admin-actions] jobs ran: adminActions ${JSON.stringify(report.report?.adminActions)}\n`,
  );

  const effective = await client.query(
    "UPDATE core.config_version SET effective_from = clock_timestamp() WHERE effective_from > now()",
  );
  process.stderr.write(
    `[dev:expedite-admin-actions] ${effective.rowCount ?? 0} configuration version(s) made effective now\n`,
  );
} finally {
  await client.end();
}
