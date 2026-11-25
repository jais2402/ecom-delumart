/**
 * Builds the file of production environment variables that Vercel imports ("Import .env"). Runs on
 * the OWNER'S OWN COMPUTER. Every secret is asked for at a prompt that does not echo and is checked
 * for its shape, so a value pasted under the wrong name is caught here and not at deploy time. The
 * file is written to the owner's home folder (never inside the repository), readable only by them,
 * and must be deleted after the import. Nothing secret is printed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { decodeCaCertificate } from "../packages/db/src/connection.ts";
import { ask, fail, say } from "./lib/owner-terminal.ts";

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_48 = /^[0-9a-f]{48}$/;

interface Secret {
  name: string;
  shape: RegExp;
  hint: string;
}

const SECRETS: Secret[] = [
  {
    name: "SUPABASE_PUBLISHABLE_KEY",
    shape: /^sb_publishable_[\w-]{10,}$/,
    hint: "starts with sb_publishable_",
  },
  { name: "SUPABASE_SECRET_KEY", shape: /^sb_secret_[\w-]{10,}$/, hint: "starts with sb_secret_" },
  { name: "IDENTITY_KEY", shape: HEX_64, hint: "64 characters from openssl rand -hex 32" },
  { name: "CARD_KEY", shape: HEX_64, hint: "64 characters from openssl rand -hex 32" },
  { name: "PIN_PEPPER", shape: HEX_64, hint: "64 characters from openssl rand -hex 32" },
  { name: "FIELD_KEY", shape: HEX_64, hint: "64 characters from openssl rand -hex 32" },
  { name: "JOBS_SIGNING_KEY", shape: HEX_64, hint: "64 characters from openssl rand -hex 32" },
  { name: "ANALYTICS_KEY", shape: HEX_64, hint: "64 characters from openssl rand -hex 32" },
  { name: "CRON_SECRET", shape: HEX_64, hint: "64 characters from openssl rand -hex 32" },
  { name: "TURNSTILE_SITE_KEY", shape: /^[\w-]{10,}$/, hint: "the Site key from Cloudflare Turnstile" },
  { name: "TURNSTILE_SECRET_KEY", shape: /^[\w-]{20,}$/, hint: "the Secret key from Cloudflare Turnstile" },
  { name: "APP_WEB_PASSWORD", shape: HEX_48, hint: "48 characters from openssl rand -hex 24" },
  { name: "APP_PAY_PASSWORD", shape: HEX_48, hint: "48 characters from openssl rand -hex 24" },
  { name: "APP_JOBS_PASSWORD", shape: HEX_48, hint: "48 characters from openssl rand -hex 24" },
];

async function askPlain(question: string, fallback: string, shape: RegExp): Promise<string> {
  for (;;) {
    const answer = (await ask(`${question} [${fallback}]: `)) || fallback;
    if (shape.test(answer)) return answer;
    say("  That does not look right. Try again, or press Return to accept the value in brackets.");
  }
}

async function askSecret(secret: Secret, seen: Map<string, string>): Promise<string> {
  for (;;) {
    const value = await ask(`${secret.name} (paste, then Return; not shown): `, true);
    if (!secret.shape.test(value)) {
      say(`  Not accepted: ${secret.name} ${secret.hint}. You pasted ${value.length} characters. Try again.`);
      continue;
    }
    const other = seen.get(value);
    if (other) {
      say(`  Not accepted: that is the same value you gave for ${other}. Every name needs its own value.`);
      continue;
    }
    seen.set(value, secret.name);
    say("  ok");
    return value;
  }
}

async function main(): Promise<void> {
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV || process.env.CI) {
    fail("Refused: this script runs on your own computer only.");
  }
  const out = join(homedir(), "delulumart-prod.env");
  const repository = resolve(import.meta.dirname, "..");
  if (resolve(out).startsWith(repository + sep)) fail("Refused: the file would be inside the repository.");

  say("This builds the file Vercel imports. Have your password manager open.\n");
  const ref = await askPlain("Supabase project ref", process.argv[2] ?? "", /^[a-z0-9]{20}$/);
  const origin = await askPlain(
    "App address",
    `https://${process.argv[3] ?? "ecom-delumart-web.vercel.app"}`,
    /^https:\/\/[a-z0-9.-]+$/,
  );
  const host = await askPlain(
    "Pooler host (Supabase: Connect -> Transaction pooler, the part after @ and before :6543)",
    "aws-0-ap-south-1.pooler.supabase.com",
    /^[a-z0-9.-]+\.pooler\.supabase\.com$/,
  );
  const certPath = await askPlain(
    "CA certificate file",
    process.env.DATABASE_CA_CERT_FILE ?? join(homedir(), "Downloads", "prod-ca-2021.crt"),
    /\S/,
  );
  if (!existsSync(certPath))
    fail(`No file at ${certPath}. Download it from Supabase (Database settings -> SSL).`);
  const pem = decodeCaCertificate(readFileSync(certPath, "utf8"));
  if (pem === null) fail("The certificate file is empty.");

  say("\nNow the secrets, one at a time. Nothing appears as you paste.\n");
  const seen = new Map<string, string>();
  const values = new Map<string, string>();
  for (const secret of SECRETS) values.set(secret.name, await askSecret(secret, seen));
  const v = (name: string): string => values.get(name) ?? fail(`missing ${name}`);
  const database = (role: string, password: string) =>
    `postgresql://app_${role}.${ref}:${password}@${host}:6543/postgres`;

  const lines = [
    "AUTH_PROVIDER=supabase",
    `APP_ORIGIN=${origin}`,
    `SUPABASE_URL=https://${ref}.supabase.co`,
    "TRUSTED_PROXY_HOPS=1",
    ...SECRETS.filter((s) => !s.name.startsWith("APP_")).map((s) => `${s.name}=${v(s.name)}`),
    `DATABASE_URL_WEB=${database("web", v("APP_WEB_PASSWORD"))}`,
    `DATABASE_URL_PAY=${database("pay", v("APP_PAY_PASSWORD"))}`,
    `DATABASE_URL_JOBS=${database("jobs", v("APP_JOBS_PASSWORD"))}`,
    `DATABASE_CA_CERT=${Buffer.from(pem, "utf8").toString("base64")}`,
  ];
  writeFileSync(out, `${lines.join("\n")}\n`, { mode: 0o600 });
  say(`\nWrote ${lines.length} variables to ${out}`);
  say(
    "Next: Vercel -> Settings -> Environment Variables -> choose Production only -> Import .env -> that file.",
  );
  say(`Then delete it:  rm ${out}`);
}

main().catch((error: unknown) => {
  say(`vercel-env failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
