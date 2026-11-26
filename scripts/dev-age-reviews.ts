/**
 * Local development only: makes today's reviews public now, as if tomorrow had come. Reviews are
 * public from the reporting day after the one they were written in (migration 0079); this moves
 * the created_at of the reviews written today back by one day, as the database owner. The browser
 * journey tests/e2e/reviews.spec.mjs runs it; there is no route for it in the app.
 *
 *     DEV_DB_NAME=delulu_dev pnpm dev:age-reviews
 *
 * Refuses anything but a database on this machine (localhost, 127.x, ::1).
 */
import { createRequire } from "node:module";
import { isLoopbackHost } from "../packages/db/src/connection.ts";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pg = require("pg") as typeof import("pg");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const DB_NAME = process.env.DEV_DB_NAME ?? "delulu_dev";

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(DB_NAME))
  throw new Error("DEV_DB_NAME must be a plain lowercase identifier");
const url = new URL(ADMIN_URL);
if (!isLoopbackHost(url.hostname)) throw new Error("dev:age-reviews runs against a local database only");
url.pathname = `/${DB_NAME}`;

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  const { rowCount } = await client.query(
    `UPDATE core.product_review SET created_at = created_at - interval '1 day'
      WHERE created_at >= core.review_public_before()`,
  );
  process.stderr.write(`[dev:age-reviews] ${rowCount ?? 0} review(s) in ${DB_NAME} moved to yesterday\n`);
} finally {
  await client.end();
}
