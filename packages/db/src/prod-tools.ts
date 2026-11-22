/**
 * Helpers of the owner-terminal scripts (scripts/db-migrate-prod.ts, db-doctor.ts, admin-grant.ts):
 * which database a connection string points at, the explicit --confirm <project-ref> check, and
 * SCRAM-SHA-256 password verifiers computed locally, so `ALTER ROLE ... PASSWORD` sends the server
 * (and any statement log) a salted verifier, never the password itself.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { isLoopbackHost } from "./connection";

export interface OwnerTarget {
  host: string;
  port: number;
  user: string;
  database: string;
  /** The Supabase project ref, from db.<ref>.supabase.co or a pooler user "<role>.<ref>". */
  projectRef: string | null;
  kind: "direct" | "pooler-session" | "pooler-transaction" | "other";
  loopback: boolean;
}

const REF = /^[a-z0-9]{20}$/;

export function parseOwnerTarget(connectionString: string): OwnerTarget {
  const url = new URL(connectionString);
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || "5432");
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  let projectRef: string | null = null;
  let kind: OwnerTarget["kind"] = "other";
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (direct?.[1] && REF.test(direct[1])) {
    projectRef = direct[1];
    kind = "direct";
  } else if (/\.pooler\.supabase\.com$/.test(host)) {
    const ref = user.split(".").pop() ?? "";
    if (user.includes(".") && REF.test(ref)) projectRef = ref;
    kind = port === 6543 ? "pooler-transaction" : "pooler-session";
  }
  return { host, port, user, database, projectRef, kind, loopback: isLoopbackHost(host) };
}

/** null when the target may be used, else the reason it is refused. */
export function confirmTarget(target: OwnerTarget, confirm: string | undefined): string | null {
  if (!confirm) {
    return "Refused: pass --confirm <project-ref> (the 20-letter id in your Supabase project's URL).";
  }
  if (target.loopback) {
    return confirm === "local"
      ? null
      : "Refused: --confirm does not match (a local database is confirmed with 'local').";
  }
  if (target.projectRef === null) {
    return "Refused: the connection string is not a Supabase database (db.<ref>.supabase.co or the pooler).";
  }
  if (confirm !== target.projectRef)
    return "Refused: --confirm does not match the project in the connection string.";
  if (target.kind === "pooler-transaction") {
    return "Refused: that is the transaction pooler (port 6543). Use the direct connection or the session pooler (port 5432).";
  }
  return null;
}

/** 24+ printable ASCII characters (no SASLprep needed), not one repeated character. */
export function strongPassword(password: string): boolean {
  return /^[\x21-\x7e]{24,128}$/.test(password) && new Set(password).size > 4;
}

/** The SCRAM-SHA-256 verifier PostgreSQL stores for an ASCII password (RFC 5802 / 7677). */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = 4096,
): string {
  if (!/^[\x20-\x7e]*$/.test(password)) throw new Error("only ASCII passwords are supported");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export type GrantOutcome = "granted" | "already" | "no-profile" | "not-active";

/**
 * Makes the profile with this email fingerprint the single Super Admin (LLD §3.1: assigned only by
 * the owner), in one transaction on the owner connection, with a SYSTEM audit row. The profile
 * exists once the account has signed in and finished the phone step. Any other Super Admin loses
 * the role (there is at most one, 0002). Nothing personal is returned or logged.
 */
export async function grantSuperAdmin(
  client: import("pg").ClientBase,
  emailFingerprint: Buffer,
): Promise<{ outcome: GrantOutcome; replacedAnother: boolean }> {
  if (emailFingerprint.length !== 32) throw new Error("an email fingerprint is 32 bytes");
  await client.query("BEGIN");
  try {
    const { rows } = await client.query<{ id: string; role: string; status: string }>(
      "SELECT id, role, status FROM core.user_profile WHERE email_fingerprint = $1 FOR UPDATE",
      [emailFingerprint],
    );
    const target = rows[0];
    if (!target) {
      await client.query("ROLLBACK");
      return { outcome: "no-profile", replacedAnother: false };
    }
    if (target.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return { outcome: "not-active", replacedAnother: false };
    }
    if (target.role === "SUPER_ADMIN") {
      await client.query("ROLLBACK");
      return { outcome: "already", replacedAnother: false };
    }
    const demoted = await client.query(
      "UPDATE core.user_profile SET role = 'PLAYER' WHERE role = 'SUPER_ADMIN' AND id <> $1",
      [target.id],
    );
    await client.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [target.id]);
    await client.query(
      `SELECT audit.append_chained(NULL, 'SYSTEM', 'super_admin.granted', 'user_profile', $1, 'owner terminal (admin:grant)', '{}'::jsonb)`,
      [target.id],
    );
    await client.query("COMMIT");
    return { outcome: "granted", replacedAnother: (demoted.rowCount ?? 0) > 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
