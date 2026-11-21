import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateProfile } from "../src/profile";
import {
  createTestDatabase,
  provisionAccount,
  provisionInput,
  stateOf,
  type TestDatabase,
  type TestUser,
} from "./helpers";

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? "unknown",
  );

describe("own profile: core.update_profile", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let a: TestUser;
  let b: TestUser;
  let n = 0;
  const handle = (prefix = "fan") => `${prefix}-${process.pid % 1000}-${++n}`;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    a = await provisionAccount(pool, provisionInput());
    b = await provisionAccount(pool, provisionInput());
  });
  afterAll(async () => {
    await db.drop();
  });

  it("sets handle, privacy and research opt-out for the signed-in user only, and returns the own profile", async () => {
    const h = handle();
    const p = await updateProfile(pool, {
      authSessionId: a.authSessionId,
      handle: h,
      privacy: { publicShelf: true },
      researchOptOut: true,
    });
    expect(p).toEqual({
      userId: a.userId,
      handle: h,
      privacy: { publicShelf: true, showCollectorLevel: false, showHandleOnPurchases: false },
      researchOptOut: true,
    });
    const other = await pool.query("SELECT handle, research_opt_out FROM core.user_profile WHERE id = $1", [
      b.userId,
    ]);
    expect(other.rows).toEqual([{ handle: null, research_opt_out: false }]);
  });

  it("null fields are left unchanged; privacy settings are merged", async () => {
    const h = handle();
    await updateProfile(pool, {
      authSessionId: b.authSessionId,
      handle: h,
      privacy: { publicShelf: true, showCollectorLevel: true },
      researchOptOut: true,
    });
    const p = await updateProfile(pool, {
      authSessionId: b.authSessionId,
      privacy: { showCollectorLevel: false },
    });
    expect(p).toMatchObject({
      handle: h,
      researchOptOut: true,
      privacy: { publicShelf: true, showCollectorLevel: false, showHandleOnPurchases: false },
    });
    const unchanged = await updateProfile(pool, { authSessionId: b.authSessionId });
    expect(unchanged).toEqual(p);
  });

  it("a handle is 3–24 lowercase letters, digits or hyphens", async () => {
    for (const bad of ["ab", "a".repeat(25), "Moon-Fan", "moon_fan", "moon fan", "möön", ""]) {
      expect(await codeOf(updateProfile(pool, { authSessionId: a.authSessionId, handle: bad })), bad).toBe(
        "VALIDATION_FAILED",
      );
    }
    expect(
      await codeOf(updateProfile(pool, { authSessionId: a.authSessionId, handle: "a".repeat(24) })),
    ).toBe("ok");
  });

  it("reserved handles are not available", async () => {
    for (const reserved of [
      "admin",
      "support",
      "delulumart",
      "staff",
      "official",
      "help",
      "system",
      "root",
      "moderator",
    ]) {
      expect(
        await codeOf(updateProfile(pool, { authSessionId: a.authSessionId, handle: reserved })),
        reserved,
      ).toBe("CONFLICT");
    }
  });

  it("a handle is unique: another user's handle is not available, and two racing claims give one winner", async () => {
    const h = handle("taken");
    await updateProfile(pool, { authSessionId: a.authSessionId, handle: h });
    expect(await codeOf(updateProfile(pool, { authSessionId: b.authSessionId, handle: h }))).toBe("CONFLICT");
    // keeping one's own handle is fine
    expect(await codeOf(updateProfile(pool, { authSessionId: a.authSessionId, handle: h }))).toBe("ok");

    const racers = await Promise.all(
      Array.from({ length: 4 }, () => provisionAccount(pool, provisionInput())),
    );
    const contested = handle("race");
    const outcomes = await Promise.all(
      racers.map((r) => codeOf(updateProfile(pool, { authSessionId: r.authSessionId, handle: contested }))),
    );
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "CONFLICT")).toHaveLength(3);
  });

  it("handles are unique ignoring case, whoever writes them", async () => {
    const h = handle("case");
    await updateProfile(pool, { authSessionId: a.authSessionId, handle: h });
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'core' AND indexname = 'user_profile_handle_ci'",
    );
    expect(rows[0]?.indexdef).toMatch(/UNIQUE INDEX .*lower\(handle\)/);
  });

  it("privacy accepts only the whitelisted boolean settings (checked in the database)", async () => {
    const call = (privacy: unknown) =>
      stateOf(pool, "SELECT core.update_profile(NULL, $1::jsonb, NULL)", [JSON.stringify(privacy)], {
        role: "app_web",
        userId: a.userId,
      });
    expect(await call({ public_shelf: true })).toBe("no error");
    expect(await call({ is_admin: true })).toBe("DM001");
    expect(await call({ public_shelf: "yes" })).toBe("DM001");
    expect(await call([true])).toBe("DM001");
    expect(
      await codeOf(
        updateProfile(pool, {
          authSessionId: a.authSessionId,
          privacy: { publicShelf: true, isAdmin: true } as unknown as { publicShelf: boolean },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("without a signed-in session it refuses; app_pay may not call it; no application role writes the profile directly", async () => {
    expect(
      await stateOf(pool, "SELECT core.update_profile('someone', NULL, NULL)", [], { role: "app_web" }),
    ).toBe("DM001");
    expect(
      await stateOf(pool, "SELECT core.update_profile('someone', NULL, NULL)", [], {
        role: "app_pay",
        userId: a.userId,
      }),
    ).toBe("42501");
    expect(
      await stateOf(pool, "UPDATE core.user_profile SET handle = 'direct' WHERE id = $1", [a.userId], {
        role: "app_web",
        userId: a.userId,
      }),
    ).toBe("42501");
  });

  it("the result carries no fingerprints or other personal data", async () => {
    const p = await updateProfile(pool, { authSessionId: a.authSessionId });
    expect(Object.keys(p).sort()).toEqual(["handle", "privacy", "researchOptOut", "userId"]);
  });
});
