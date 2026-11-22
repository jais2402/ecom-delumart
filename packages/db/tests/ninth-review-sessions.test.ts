import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endSession, registerAppSession } from "../src/deployment";
import { sessionActor } from "../src/session-actor";
import { countRows, createTestDatabase, sessionFor, stateOf, type TestDatabase, uuidv7 } from "./helpers";

const OTHER_ROLES = ["app_pay", "app_jobs", "npc_worker", "research_ro"] as const;

/**
 * Ninth security review, minors 3 and 4 (migration 0074): only sessions the web server accepted
 * (core.app_session, written by core.register_app_session) sign anyone in; an ended session stays
 * ended whatever lifetime the owner sets later.
 */
describe("ninth review: accepted sessions only, and ended sessions stay ended", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  });
  afterAll(async () => {
    await db.drop();
  });

  /** A user and a session row as the sign-in service writes it, NOT accepted by the web server. */
  async function rawSession(
    options: { createdAgo?: string; notAfter?: string } = {},
  ): Promise<{ userId: string; sessionId: string }> {
    const userId = uuidv7();
    const sessionId = uuidv7();
    await pool.query("INSERT INTO auth.users (id) VALUES ($1)", [userId]);
    await pool.query(
      `INSERT INTO auth.sessions (id, user_id, created_at, not_after)
       VALUES ($1, $2, now() - $3::interval, $4::timestamptz)`,
      [sessionId, userId, options.createdAgo ?? "0 seconds", options.notAfter ?? null],
    );
    return { userId, sessionId };
  }

  describe("minor 4: core.app_session", () => {
    it("minor 4: a live auth.sessions row the web server never accepted signs nobody in; once registered it does", async () => {
      const { userId, sessionId } = await rawSession();
      expect(await sessionActor(pool, { authSessionId: sessionId })).toBeNull();
      expect(await registerAppSession(pool, { authSessionId: sessionId, userId })).toBe(true);
      expect((await sessionActor(pool, { authSessionId: sessionId }))?.userId).toBe(userId);
      // registering again is harmless
      expect(await registerAppSession(pool, { authSessionId: sessionId, userId })).toBe(true);
    });

    it("minor 4: registration re-checks the session: another user's, unknown, expired, too old, ended, banned or deleted are refused and write nothing", async () => {
      const a = await rawSession();
      const b = await rawSession();
      const expired = await rawSession({ notAfter: new Date(Date.now() - 60_000).toISOString() });
      const tooOld = await rawSession({ createdAgo: "8 days" });
      const ended = await rawSession();
      await pool.query("INSERT INTO core.ended_session (session_id) VALUES ($1)", [ended.sessionId]);
      const banned = await rawSession();
      await pool.query("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1", [
        banned.userId,
      ]);
      const deleted = await rawSession();
      await pool.query("UPDATE auth.users SET deleted_at = now() WHERE id = $1", [deleted.userId]);
      const refused = [
        { authSessionId: a.sessionId, userId: b.userId },
        { authSessionId: uuidv7(), userId: a.userId },
        { authSessionId: expired.sessionId, userId: expired.userId },
        { authSessionId: tooOld.sessionId, userId: tooOld.userId },
        { authSessionId: ended.sessionId, userId: ended.userId },
        { authSessionId: banned.sessionId, userId: banned.userId },
        { authSessionId: deleted.sessionId, userId: deleted.userId },
      ];
      for (const input of refused) expect(await registerAppSession(pool, input)).toBe(false);
      expect(
        await countRows(
          pool,
          "SELECT count(*) AS n FROM core.app_session WHERE session_id = ANY ($1::uuid[])",
          [refused.map((r) => r.authSessionId)],
        ),
      ).toBe(0);
      expect(await sessionActor(pool, { authSessionId: a.sessionId })).toBeNull();
    });

    it("minor 4: only app_web may register; no application role reads or writes core.app_session", async () => {
      const { userId, sessionId } = await rawSession();
      for (const role of OTHER_ROLES) {
        expect(
          await stateOf(pool, "SELECT core.register_app_session($1, $2)", [sessionId, userId], { role }),
          role,
        ).toBe("42501");
      }
      for (const role of ["app_web", ...OTHER_ROLES]) {
        expect(await stateOf(pool, "SELECT * FROM core.app_session", [], { role }), role).toBe("42501");
        expect(
          await stateOf(
            pool,
            "INSERT INTO core.app_session (session_id, user_id) VALUES ($1, $2)",
            [sessionId, userId],
            {
              role,
            },
          ),
          role,
        ).toBe("42501");
      }
    });

    it("minor 4: every function that names the actor goes through core.actor_id(); no other function reads auth.sessions to find a user", async () => {
      const { rows } = await pool.query<{ fn: string }>(
        `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~* 'auth\\.sessions'
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.fn).sort()).toEqual(
        [
          // the session check itself
          "core.actor_id()",
          // reads created_at of the session core.actor_id() accepted
          "core.actor_session_created_at()",
          // sign-out: inserts the end record, deletes the row
          "core.end_session()",
          // registration: re-checks the row before accepting it
          "core.register_app_session(uuid,uuid)",
        ].sort(),
      );
    });
  });

  describe("minor 3: ended sessions never come back", () => {
    it("minor 3: a short lifetime does not purge the end record of a session whose row the platform kept; raising the lifetime later does not revive it", async () => {
      const kept = await sessionFor(pool, uuidv7());
      const keptUser = (await sessionActor(pool, { authSessionId: kept }))?.userId;
      expect(keptUser).toBeDefined();
      // signed out two days ago while the platform kept the auth.sessions row (no DELETE privilege)
      await pool.query(
        "INSERT INTO core.ended_session (session_id, ended_at) VALUES ($1, now() - interval '2 days')",
        [kept],
      );
      await pool.query("UPDATE auth.sessions SET created_at = now() - interval '3 days' WHERE id = $1", [
        kept,
      ]);
      await pool.query(
        "UPDATE core.deployment_setting SET value = '300' WHERE key = 'auth.session_max_age_seconds'",
      );
      try {
        // someone else signs out: the purge runs
        const other = await sessionFor(pool, uuidv7());
        await endSession(pool, { authSessionId: other });
        expect(
          await countRows(pool, "SELECT count(*) AS n FROM core.ended_session WHERE session_id = $1", [kept]),
        ).toBe(1);
      } finally {
        await pool.query(
          "UPDATE core.deployment_setting SET value = '604800' WHERE key = 'auth.session_max_age_seconds'",
        );
      }
      // the owner raised the lifetime back to 7 days: the 3-day-old session stays signed out
      expect(await sessionActor(pool, { authSessionId: kept })).toBeNull();
    });

    it("minor 3: records older than the longest allowed lifetime plus a day, or whose session row is gone, are purged", async () => {
      const ancient = await sessionFor(pool, uuidv7());
      const gone = uuidv7();
      await pool.query(
        `INSERT INTO core.ended_session (session_id, ended_at) VALUES
           ($1, now() - make_interval(secs => 7776000) - interval '2 days'),
           ($2, now() - interval '1 hour')`,
        [ancient, gone],
      );
      const other = await sessionFor(pool, uuidv7());
      await endSession(pool, { authSessionId: other });
      expect(
        await countRows(
          pool,
          "SELECT count(*) AS n FROM core.ended_session WHERE session_id = ANY ($1::uuid[])",
          [[ancient, gone]],
        ),
      ).toBe(0);
    });
  });
});
