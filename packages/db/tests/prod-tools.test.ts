import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  confirmTarget,
  grantSuperAdmin,
  parseOwnerTarget,
  scramSha256Verifier,
  strongPassword,
} from "../src/prod-tools";
import { ADMIN_URL, createTestDatabase, provisionAccount, provisionInput } from "./helpers";

describe("owner-terminal tools: target, confirmation, passwords", () => {
  it("reads the project ref from a direct connection host and from a pooler user name", () => {
    const direct = parseOwnerTarget(
      "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
    );
    expect(direct).toMatchObject({ projectRef: "abcdefghijklmnopqrst", kind: "direct", loopback: false });
    const session = parseOwnerTarget(
      "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
    );
    expect(session).toMatchObject({ projectRef: "abcdefghijklmnopqrst", kind: "pooler-session" });
    const tx = parseOwnerTarget(
      "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
    );
    expect(tx.kind).toBe("pooler-transaction");
    expect(parseOwnerTarget("postgres://postgres:postgres@127.0.0.1:5432/x")).toMatchObject({
      projectRef: null,
      loopback: true,
    });
    // the parsed target never carries the password
    expect(JSON.stringify(direct)).not.toContain("secret");
  });

  it("refuses without a --confirm that names the same project; the transaction pooler is refused for migrations", () => {
    const t = parseOwnerTarget("postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres");
    expect(confirmTarget(t, undefined)).toMatch(/--confirm/);
    expect(confirmTarget(t, "zzzzzzzzzzzzzzzzzzzz")).toMatch(/does not match/);
    expect(confirmTarget(t, "abcdefghijklmnopqrst")).toBeNull();
    const tx = parseOwnerTarget(
      "postgresql://postgres.abcdefghijklmnopqrst:x@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
    );
    expect(confirmTarget(tx, "abcdefghijklmnopqrst")).toMatch(/transaction pooler/);
    const local = parseOwnerTarget("postgres://postgres:postgres@127.0.0.1:5432/x");
    expect(confirmTarget(local, "local")).toBeNull();
    expect(confirmTarget(local, "abcdefghijklmnopqrst")).toMatch(/does not match/);
    const other = parseOwnerTarget("postgres://u:p@db.example.org:5432/x");
    expect(confirmTarget(other, "db")).toMatch(/not a Supabase/);
  });

  it("application passwords must be long random ASCII", () => {
    expect(strongPassword("short")).toBe(false);
    expect(strongPassword("a".repeat(40))).toBe(false); // one repeated character
    expect(strongPassword("pässwörd".repeat(5))).toBe(false); // non-ASCII: SASLprep would be needed
    expect(strongPassword(randomBytes(24).toString("hex"))).toBe(true);
  });

  it("a SCRAM-SHA-256 verifier made here logs in with the password (the plain password never reaches the server)", async () => {
    const role = `delulu_scram_${randomBytes(4).toString("hex")}`;
    const password = randomBytes(24).toString("hex");
    const verifier = scramSha256Verifier(password, randomBytes(16));
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(verifier).not.toContain(password);
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${admin.escapeLiteral(verifier)}`);
      const url = new URL(ADMIN_URL);
      url.username = role;
      url.password = password;
      url.pathname = "/postgres";
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      const { rows } = await c.query<{ u: string }>("SELECT current_user AS u");
      expect(rows[0]?.u).toBe(role);
      await c.end();
      url.password = `${password}x`;
      const wrong = new pg.Client({ connectionString: url.toString() });
      await expect(wrong.connect()).rejects.toThrow();
      await wrong.end().catch(() => undefined);
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
});

describe("admin:grant: the first Super Admin, by email fingerprint, from the owner terminal", () => {
  it("grants the role to the profile with that fingerprint, replaces any other, audits it; unknown fingerprints change nothing", async () => {
    const db = await createTestDatabase();
    try {
      const a = provisionInput();
      const b = provisionInput();
      const ua = await provisionAccount(db.pool, a);
      const ub = await provisionAccount(db.pool, b);
      const c = await db.pool.connect();
      try {
        expect(await grantSuperAdmin(c, randomBytes(32))).toEqual({
          outcome: "no-profile",
          replacedAnother: false,
        });
        expect(await grantSuperAdmin(c, a.emailFingerprint)).toEqual({
          outcome: "granted",
          replacedAnother: false,
        });
        expect(await grantSuperAdmin(c, a.emailFingerprint)).toEqual({
          outcome: "already",
          replacedAnother: false,
        });
        expect(await grantSuperAdmin(c, b.emailFingerprint)).toEqual({
          outcome: "granted",
          replacedAnother: true,
        });
      } finally {
        c.release();
      }
      const { rows } = await db.pool.query<{ id: string; role: string }>(
        "SELECT id, role FROM core.user_profile WHERE id = ANY($1::uuid[]) ORDER BY role",
        [[ua.userId, ub.userId]],
      );
      expect(rows).toEqual([
        { id: ua.userId, role: "PLAYER" },
        { id: ub.userId, role: "SUPER_ADMIN" },
      ]);
      const audit = await db.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM audit.audit_log WHERE action = 'super_admin.granted' AND actor_kind = 'SYSTEM'",
      );
      expect(Number(audit.rows[0]?.n)).toBe(2);
    } finally {
      await db.drop();
    }
  });
});
