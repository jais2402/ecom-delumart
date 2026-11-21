import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionActor } from "../src/session-actor";
import {
  createTestDatabase,
  onboard,
  provisionInput,
  sessionFor,
  type TestDatabase,
  uuidv7,
} from "./helpers";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

describe("sessionActor (server-internal: who the sign-in session belongs to)", () => {
  it("US-01: answers null for an unknown, malformed-free but made-up session id", async () => {
    expect(await sessionActor(db.pool, { authSessionId: uuidv7() })).toBeNull();
  });

  it("US-01: answers null for an expired session", async () => {
    const userId = uuidv7();
    const sid = await sessionFor(db.pool, userId);
    await db.pool.query("UPDATE auth.sessions SET not_after = now() - interval '1 minute' WHERE id = $1", [
      sid,
    ]);
    expect(await sessionActor(db.pool, { authSessionId: sid })).toBeNull();
  });

  it("US-01: names the user of a live session before any profile exists", async () => {
    const userId = uuidv7();
    const sid = await sessionFor(db.pool, userId);
    expect(await sessionActor(db.pool, { authSessionId: sid })).toEqual({
      userId,
      profile: null,
      birthdateEnc: null,
    });
  });

  it("US-49: returns the actor's own fingerprints and encrypted birthdate, never another user's", async () => {
    const a = provisionInput();
    const b = provisionInput();
    const sidA = await sessionFor(db.pool, a.userId);
    const sidB = await sessionFor(db.pool, b.userId);
    await onboard(db.pool, a, sidA);
    const actorA = await sessionActor(db.pool, { authSessionId: sidA });
    expect(actorA?.userId).toBe(a.userId);
    expect(actorA?.profile?.emailFingerprint.equals(a.emailFingerprint)).toBe(true);
    expect(actorA?.profile?.phoneFingerprint?.equals(a.phoneFingerprint as Buffer)).toBe(true);
    expect(actorA?.profile?.handle).toBeNull();
    expect(actorA?.birthdateEnc?.equals(a.birthdateEnc)).toBe(true);
    const actorB = await sessionActor(db.pool, { authSessionId: sidB });
    expect(actorB).toEqual({ userId: b.userId, profile: null, birthdateEnc: null });
  });

  it("rejects a session id that is not a uuid without querying", async () => {
    await expect(
      sessionActor(db.pool, { authSessionId: randomBytes(4).toString("hex") }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});
