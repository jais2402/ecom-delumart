import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminHealth, endSession, phoneVerificationMode } from "../src/deployment";
import { acceptJobsRequest } from "../src/jobs";
import { onboardingStatus, recordPhoneVerified } from "../src/onboarding";
import { sessionActor } from "../src/session-actor";
import {
  countRows,
  createTestDatabase,
  inTx,
  provisionAccount,
  provisionInput,
  sessionFor,
  stateOf,
  type TestDatabase,
  uuidv7,
} from "./helpers";

const APP_ROLES = ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"] as const;

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? "unknown",
  );

describe("deployment settings, phone mode, session lifetime and sign-out (0070-0073)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  });
  afterAll(async () => {
    await db.drop();
  });

  async function setPhoneMode(mode: "sms" | "unverified"): Promise<void> {
    await pool.query(
      "UPDATE core.deployment_setting SET value = $1 WHERE key = 'identity.phone_verification'",
      [mode],
    );
  }

  async function signedInUser(): Promise<{ userId: string; sessionId: string }> {
    const userId = uuidv7();
    return { userId, sessionId: await sessionFor(pool, userId) };
  }

  describe("the phone verification mode", () => {
    it("defaults to 'sms' and the web role reads it through core.phone_verification_mode()", async () => {
      expect(await phoneVerificationMode(pool)).toBe("sms");
    });

    for (const role of APP_ROLES) {
      it(`${role} cannot read, insert, update or delete a deployment setting (owner-only)`, async () => {
        const as = { role };
        expect(await stateOf(pool, "SELECT * FROM core.deployment_setting", [], as)).toBe("42501");
        expect(
          await stateOf(
            pool,
            "UPDATE core.deployment_setting SET value = 'unverified' WHERE key = 'identity.phone_verification'",
            [],
            as,
          ),
        ).toBe("42501");
        expect(
          await stateOf(
            pool,
            "DELETE FROM core.deployment_setting WHERE key = 'identity.phone_verification'",
            [],
            as,
          ),
        ).toBe("42501");
        expect(
          await stateOf(
            pool,
            "INSERT INTO core.deployment_setting (key, value) VALUES ('identity.phone_verification', 'unverified') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            [],
            as,
          ),
        ).toBe("42501");
      });
    }

    it("'unverified' mode cannot be switched on by any application role: no function they may execute writes the setting", async () => {
      const { rows } = await pool.query<{ role: string; f: string }>(
        `SELECT r AS role, p.oid::regprocedure::text AS f
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                unnest($1::text[]) r
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+core\\.deployment_setting'
            AND has_function_privilege(r, p.oid, 'EXECUTE')`,
        [[...APP_ROLES, "anon", "authenticated"]],
      );
      expect(rows).toEqual([]);
      // and the column values are constrained: only the two modes exist
      expect(
        await codeOf(
          pool.query(
            "UPDATE core.deployment_setting SET value = 'off' WHERE key = 'identity.phone_verification'",
          ),
        ),
      ).toBe("23514");
    });

    it("'sms' mode: a recorded phone is marked phone_verified = true", async () => {
      await setPhoneMode("sms");
      const input = provisionInput();
      const user = await provisionAccount(pool, input);
      const { rows } = await pool.query<{ v: boolean | null }>(
        "SELECT phone_verified AS v FROM core.user_profile WHERE id = $1",
        [user.userId],
      );
      expect(rows[0]?.v).toBe(true);
    });

    it("'unverified' mode: the phone is recorded without SMS, marked phone_verified = false, and still one account per phone", async () => {
      await setPhoneMode("unverified");
      try {
        const a = await signedInUser();
        const phoneFingerprint = randomBytes(32);
        const status = await recordPhoneVerified(pool, {
          authSessionId: a.sessionId,
          phoneFingerprint,
          emailFingerprint: randomBytes(32),
        });
        expect(status.phoneVerified).toBe(true); // the phone STEP is done
        const { rows } = await pool.query<{ v: boolean | null }>(
          "SELECT phone_verified AS v FROM core.user_profile WHERE id = $1",
          [a.userId],
        );
        expect(rows[0]?.v).toBe(false);
        // the same number for a second account: the uniform CONFLICT of 0024
        const b = await signedInUser();
        expect(
          await codeOf(
            recordPhoneVerified(pool, {
              authSessionId: b.sessionId,
              phoneFingerprint,
              emailFingerprint: randomBytes(32),
            }),
          ),
        ).toBe("CONFLICT");
        expect((await onboardingStatus(pool, { authSessionId: b.sessionId })).phoneVerified).toBe(false);
      } finally {
        await setPhoneMode("sms");
      }
    });

    it("phone_verified is computed by the database, never taken from a writer", async () => {
      const a = await signedInUser();
      await recordPhoneVerified(pool, {
        authSessionId: a.sessionId,
        phoneFingerprint: randomBytes(32),
        emailFingerprint: randomBytes(32),
      });
      // even the owner cannot flip it without changing the phone
      await pool.query("UPDATE core.user_profile SET phone_verified = false WHERE id = $1", [a.userId]);
      const { rows } = await pool.query<{ v: boolean }>(
        "SELECT phone_verified AS v FROM core.user_profile WHERE id = $1",
        [a.userId],
      );
      expect(rows[0]?.v).toBe(true);
    });
  });

  describe("session lifetime (absolute, from auth.sessions.created_at)", () => {
    it("a session older than auth.session_max_age_seconds signs nobody in; a younger one does", async () => {
      const { userId } = await signedInUser();
      const old = uuidv7();
      const young = uuidv7();
      await pool.query(
        `INSERT INTO auth.sessions (id, user_id, created_at) VALUES
           ($1, $3, now() - interval '8 days'), ($2, $3, now() - interval '6 days')`,
        [old, young, userId],
      );
      expect(await sessionActor(pool, { authSessionId: old })).toBeNull();
      expect((await sessionActor(pool, { authSessionId: young }))?.userId).toBe(userId);
      // the owner shortens the lifetime: the 6-day-old session ends too
      await pool.query(
        "UPDATE core.deployment_setting SET value = '86400' WHERE key = 'auth.session_max_age_seconds'",
      );
      try {
        expect(await sessionActor(pool, { authSessionId: young })).toBeNull();
      } finally {
        await pool.query(
          "UPDATE core.deployment_setting SET value = '604800' WHERE key = 'auth.session_max_age_seconds'",
        );
      }
      expect(
        await codeOf(
          pool.query(
            "UPDATE core.deployment_setting SET value = '10' WHERE key = 'auth.session_max_age_seconds'",
          ),
        ),
      ).toBe("23514");
    });
  });

  describe("sign-out: core.end_session()", () => {
    it("ends the caller's session for good and deletes its auth.sessions row when the owner may", async () => {
      const { userId, sessionId } = await signedInUser();
      expect((await sessionActor(pool, { authSessionId: sessionId }))?.userId).toBe(userId);
      await endSession(pool, { authSessionId: sessionId });
      expect(await sessionActor(pool, { authSessionId: sessionId })).toBeNull();
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM auth.sessions WHERE id = $1", [sessionId]),
      ).toBe(0);
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.ended_session WHERE session_id = $1", [
          sessionId,
        ]),
      ).toBe(1);
      // repeating it is harmless
      await endSession(pool, { authSessionId: sessionId });
    });

    it("a recorded end signs the session out even when its auth.sessions row stays (the managed platform keeps it)", async () => {
      const { sessionId } = await signedInUser();
      await pool.query("INSERT INTO core.ended_session (session_id) VALUES ($1)", [sessionId]);
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM auth.sessions WHERE id = $1", [sessionId]),
      ).toBe(1);
      expect(await sessionActor(pool, { authSessionId: sessionId })).toBeNull();
    });

    it("an unknown or made-up session id is not remembered; only app_web may call it", async () => {
      const made = uuidv7();
      await endSession(pool, { authSessionId: made });
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.ended_session WHERE session_id = $1", [made]),
      ).toBe(0);
      for (const role of ["app_pay", "app_jobs", "npc_worker", "research_ro", "anon", "authenticated"]) {
        expect(await stateOf(pool, "SELECT core.end_session()", [], { role })).toBe("42501");
      }
    });

    it("app_web can neither read nor write core.ended_session directly", async () => {
      const { userId } = await signedInUser();
      expect(await stateOf(pool, "SELECT * FROM core.ended_session", [], { role: "app_web", userId })).toBe(
        "42501",
      );
      expect(await stateOf(pool, "DELETE FROM core.ended_session", [], { role: "app_web", userId })).toBe(
        "42501",
      );
    });
  });

  describe("operations health (Super Admin)", () => {
    it("FORBIDDEN for anyone but the Super Admin; reports migration, phone mode and the last job run, no secrets", async () => {
      const player = await provisionAccount(pool, provisionInput());
      expect(await codeOf(adminHealth(pool, { authSessionId: player.authSessionId }))).toBe("FORBIDDEN");
      const admin = await provisionAccount(pool, provisionInput());
      await inTx(pool, async (c) => {
        await c.query("UPDATE core.user_profile SET role = 'PLAYER' WHERE role = 'SUPER_ADMIN'");
        await c.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
      });
      const before = await adminHealth(pool, { authSessionId: admin.authSessionId });
      expect(before.migrationVersion).toMatch(/^\d{4}$/);
      expect(before.phoneVerification).toBe("sms");
      expect(before.sessionMaxAgeSeconds).toBe(604800);
      expect(before.jobsLastRunAt).toBeNull();

      const signature = createHash("sha256").update(randomBytes(16)).digest();
      expect(await acceptJobsRequest(pool, { signatureHash: signature, requestAt: new Date() })).toBe(true);
      const after = await adminHealth(pool, { authSessionId: admin.authSessionId });
      expect(after.jobsLastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(after.jobsRuns).toBe(1);
      expect(Object.keys(after).sort()).toEqual([
        "jobsLastRunAt",
        "jobsRuns",
        "migrationVersion",
        "phoneVerification",
        "sessionMaxAgeSeconds",
      ]);
    });
  });

  describe("the managed platform's API roles (0073)", () => {
    it("anon and authenticated hold nothing on any application schema, table, sequence or function, nor on the migration ledger", async () => {
      for (const role of ["anon", "authenticated"]) {
        const { rows } = await pool.query<{ what: string }>(
          `SELECT 'schema ' || n.nspname AS what FROM pg_namespace n
            WHERE n.nspname = ANY($2::text[]) AND (has_schema_privilege($1, n.oid, 'USAGE') OR has_schema_privilege($1, n.oid, 'CREATE'))
           UNION ALL
           SELECT 'table ' || c.oid::regclass::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE (n.nspname = ANY($2::text[]) OR c.oid = 'public.schema_migrations'::regclass)
              AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
              AND (has_table_privilege($1, c.oid, 'SELECT') OR has_table_privilege($1, c.oid, 'INSERT')
                   OR has_table_privilege($1, c.oid, 'UPDATE') OR has_table_privilege($1, c.oid, 'DELETE'))`,
          [role, ["core", "ledger", "private", "sandbox", "analytics", "audit", "research", "ops"]],
        );
        expect(rows.map((r) => r.what)).toEqual([]);
      }
    });

    it("ops.revoke_platform_api_roles() is idempotent and owner-only", async () => {
      const { rows } = await pool.query<{ n: number }>("SELECT ops.revoke_platform_api_roles() AS n");
      expect(rows[0]?.n).toBeGreaterThanOrEqual(2);
      for (const role of ["app_web", "app_pay", "app_jobs", "anon", "authenticated"]) {
        expect(await stateOf(pool, "SELECT ops.revoke_platform_api_roles()", [], { role })).toBe("42501");
      }
    });
  });
});
