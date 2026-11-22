/**
 * Shared by the owner-terminal scripts (db-doctor, db-migrate-prod, admin-grant). They run on the
 * OWNER'S OWN COMPUTER, never on Vercel or in CI: the owner (postgres) connection string is read
 * from DATABASE_URL_OWNER in that terminal only. Nothing secret is ever printed: no connection
 * string, password, key or email; only the host, the project ref and results.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { Pool as PgPool } from "pg";
import { connectionConfig, decodeCaCertificate } from "../../packages/db/src/connection.ts";
import { confirmTarget, type OwnerTarget, parseOwnerTarget } from "../../packages/db/src/prod-tools.ts";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const pg = require("pg") as typeof import("pg");

export const say = (message: string) => process.stderr.write(`${message}\n`);

export function fail(message: string): never {
  say(message);
  process.exit(1);
}

export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export const hasFlag = (name: string) => process.argv.includes(name);

/** The owner connection string from this terminal; refused on Vercel or in CI. */
export function ownerTarget(options: { requireConfirm: boolean }): { url: string; target: OwnerTarget } {
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) {
    fail("Refused: this script runs on your own computer, never on Vercel.");
  }
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) {
    fail(
      "Set DATABASE_URL_OWNER in THIS terminal first (Supabase: Connect -> Session pooler, port 5432).\n" +
        "Never put it in Vercel or in a file you commit.",
    );
  }
  let target: OwnerTarget;
  try {
    target = parseOwnerTarget(url);
  } catch {
    fail("DATABASE_URL_OWNER is not a valid postgres:// connection string.");
  }
  if (options.requireConfirm) {
    const problem = confirmTarget(target, argValue("--confirm"));
    if (problem) fail(problem);
  }
  return { url, target };
}

/** The CA certificate: DATABASE_CA_CERT (PEM or base64) or DATABASE_CA_CERT_FILE (a path). */
export function caCertificate(): string | null {
  const file = process.env.DATABASE_CA_CERT_FILE;
  try {
    if (file) return decodeCaCertificate(readFileSync(file, "utf8"));
    return decodeCaCertificate(process.env.DATABASE_CA_CERT);
  } catch {
    fail("DATABASE_CA_CERT / DATABASE_CA_CERT_FILE is not a PEM certificate.");
  }
}

/** A small pool with TLS verified against the CA (plain only for a database on this machine). */
export function ownerPool(url: string, target: OwnerTarget): PgPool {
  const ca = caCertificate();
  if (!target.loopback && ca === null) {
    say(
      "Note: no DATABASE_CA_CERT_FILE given; the server certificate is checked against your system's trusted roots.\n" +
        "If the connection fails with a certificate error, download the CA certificate from Supabase\n" +
        "(Database settings -> SSL) and set DATABASE_CA_CERT_FILE=/path/to/prod-ca-2021.crt",
    );
  }
  return new pg.Pool({
    ...connectionConfig({ url, tls: target.loopback ? "disable" : "verify-full", caPem: ca }),
    max: 2,
    connectionTimeoutMillis: 15_000,
    application_name: "delulu-owner-terminal",
  });
}

export function describeTarget(target: OwnerTarget): string {
  return target.loopback
    ? `local database ${target.database} on ${target.host}`
    : `Supabase project ${target.projectRef ?? "?"} (${target.kind}, ${target.host})`;
}

/** Asks a question on the terminal; `hidden` does not echo what is typed. */
export async function ask(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY)
    fail("This needs an interactive terminal (or the documented environment variables).");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (hidden) {
    const r = rl as unknown as { _writeToOutput: (s: string) => void };
    let asked = false;
    r._writeToOutput = (s: string) => {
      if (!asked) {
        process.stderr.write(s);
        asked = true;
      }
    };
  }
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  if (hidden) process.stderr.write("\n");
  return answer.trim();
}

/** Explains a connection error without echoing anything secret. */
export function explain(error: unknown): string {
  const e = error as { code?: string; message?: string };
  const code = e.code ?? "";
  if (code === "28P01")
    return "password authentication failed (check the password part of DATABASE_URL_OWNER)";
  if (code === "ENOTFOUND") return "host not found (check the host in DATABASE_URL_OWNER)";
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED")
    return "could not reach the database (network, or the direct host needs IPv6: use the Session pooler)";
  if (
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  ) {
    return "the server certificate is not trusted: set DATABASE_CA_CERT_FILE to Supabase's CA certificate";
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "the certificate does not match the host name";
  if (code === "42501") return "permission denied (send this whole output, it names the object)";
  return `${code ? `[${code}] ` : ""}${(e.message ?? "unknown error").replace(/postgres(ql)?:\/\/\S+/g, "<url>")}`;
}
