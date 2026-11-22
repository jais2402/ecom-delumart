// Build check: no browser bundle may contain a server secret's name or value. Runs after
// `next build` (see the "build" script). Values are taken from the environment and from
// apps/web/.env.local when present; names are checked always (a name in a client chunk means a
// server module was bundled for the browser).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const staticDir = join(root, ".next", "static");
const NAMES = [
  "DATABASE_URL_WEB",
  "DATABASE_URL_PAY",
  "DATABASE_URL_OWNER",
  "DATABASE_URL_JOBS",
  "IDENTITY_KEY",
  "CARD_KEY",
  "PIN_PEPPER",
  "FIELD_KEY",
  "JOBS_SIGNING_KEY",
  "ANALYTICS_KEY",
  "CRON_SECRET",
  "SUPABASE_SECRET_KEY",
];
// Any Supabase secret key at all (sb_secret_...), whatever variable it came from.
const PATTERNS = [/sb_secret_[A-Za-z0-9_-]{10,}/];

function envFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const local = envFile(join(root, ".env.local"));
const values = NAMES.flatMap((n) => [process.env[n], local[n]]).filter(
  (v) => typeof v === "string" && v.length >= 16,
);
const needles = [...NAMES, ...values];

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|css|html|json|txt|map)$/.test(entry)) yield path;
  }
}

if (!existsSync(staticDir)) {
  console.error("check-client-bundle: .next/static not found; run next build first");
  process.exit(1);
}
let scanned = 0;
const leaks = [];
for (const file of files(staticDir)) {
  scanned += 1;
  const text = readFileSync(file, "utf8");
  for (const needle of needles) {
    if (text.includes(needle))
      leaks.push(`${file.slice(root.length)}: ${NAMES.includes(needle) ? needle : "a secret value"}`);
  }
  for (const pattern of PATTERNS) {
    if (pattern.test(text)) leaks.push(`${file.slice(root.length)}: a Supabase secret key`);
  }
}
if (leaks.length > 0) {
  console.error(`check-client-bundle: server secrets found in client bundles:\n${leaks.join("\n")}`);
  process.exit(1);
}
console.log(
  `check-client-bundle: ${scanned} client files clean (${NAMES.length} names, ${values.length} values)`,
);
