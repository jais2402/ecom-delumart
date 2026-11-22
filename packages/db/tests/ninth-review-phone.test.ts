import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { onboardingStatus, recordPhoneVerified } from "../src/onboarding";
import {
  authPhoneHolder,
  expiredPhoneHolds,
  phoneHoldDone,
  phoneHoldSet,
  phoneNumberAttempt,
} from "../src/phone";
import { wallet } from "./checkout-fixtures";
import {
  createTestDatabase,
  provisionAccount,
  provisionInput,
  sessionFor,
  stateOf,
  type TestDatabase,
  uuidv7,
} from "./helpers";

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? "unknown",
  );

/**
 * Ninth security review, major 1 (migration 0075): squatted phone numbers are released, never at
 * the expense of a confirmed holder, and an unverified number is reported as unverified.
 */
describe("ninth review, major 1: phone claims", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  });
  afterAll(async () => {
    await db.drop();
  });
  afterEach(async () => {
    await setMode("sms");
  });

  async function setMode(mode: "sms" | "unverified"): Promise<void> {
    await pool.query(
      "UPDATE core.deployment_setting SET value = $1 WHERE key = 'identity.phone_verification'",
      [mode],
    );
  }
  async function signedIn(): Promise<{ userId: string; sessionId: string }> {
    const userId = uuidv7();
    return { userId, sessionId: await sessionFor(pool, userId) };
  }
  const claim = (sessionId: string, phoneFingerprint: Buffer) =>
    recordPhoneVerified(pool, {
      authSessionId: sessionId,
      phoneFingerprint,
      emailFingerprint: randomBytes(32),
    });
  const status = (sessionId: string) => onboardingStatus(pool, { authSessionId: sessionId });

  it("major 1: in 'unverified' mode the status says the step is done but the number is not verified", async () => {
    await setMode("unverified");
    const a = await signedIn();
    const s = await claim(a.sessionId, randomBytes(32));
    expect(s).toMatchObject({ phoneRecorded: true, phoneVerified: false, phoneReverifyRequired: false });
    expect(await status(a.sessionId)).toMatchObject({ phoneRecorded: true, phoneVerified: false });
  });

  it("major 1: a number recorded unverified does not block its SMS-confirmed owner: the confirmed claim wins, the holder is asked again, nothing else changes", async () => {
    await setMode("unverified");
    const fp = randomBytes(32);
    const squatter = await provisionAccount(pool, provisionInput({ phoneFingerprint: fp }));
    const balance = await wallet(pool, squatter.ledgerAccountId);
    await setMode("sms");
    const owner = await signedIn();
    expect(await claim(owner.sessionId, fp)).toMatchObject({ phoneRecorded: true, phoneVerified: true });
    expect(await status(squatter.authSessionId)).toMatchObject({
      phoneRecorded: false,
      phoneVerified: false,
      phoneReverifyRequired: true,
      provisioned: true,
    });
    expect(await wallet(pool, squatter.ledgerAccountId)).toBe(balance);
    // the former holder records another number: the flag clears
    const again = await claim(squatter.authSessionId, randomBytes(32));
    expect(again).toMatchObject({ phoneRecorded: true, phoneVerified: true, phoneReverifyRequired: false });
  });

  it("major 1: a CONFIRMED holder is never touched, by a confirmed or an unverified claim", async () => {
    const fp = randomBytes(32);
    const holder = await signedIn();
    await claim(holder.sessionId, fp);
    const other = await signedIn();
    expect(await codeOf(claim(other.sessionId, fp))).toBe("CONFLICT");
    await setMode("unverified");
    expect(await codeOf(claim(other.sessionId, fp))).toBe("CONFLICT");
    expect(await status(holder.sessionId)).toMatchObject({ phoneRecorded: true, phoneVerified: true });
  });

  it("major 1: two unverified claims: the first wins for 24 hours; then it lapses unless the holder completed onboarding", async () => {
    await setMode("unverified");
    const fp = randomBytes(32);
    const first = await signedIn();
    await claim(first.sessionId, fp);
    const second = await signedIn();
    expect(await codeOf(claim(second.sessionId, fp))).toBe("CONFLICT");
    await pool.query(
      "UPDATE core.user_profile SET phone_verified_at = now() - interval '25 hours' WHERE id = $1",
      [first.userId],
    );
    expect(await claim(second.sessionId, fp)).toMatchObject({ phoneRecorded: true, phoneVerified: false });
    expect(await status(first.sessionId)).toMatchObject({
      phoneRecorded: false,
      phoneReverifyRequired: true,
    });

    // a holder who completed onboarding keeps an unverified number however old the claim
    const fp2 = randomBytes(32);
    const established = await provisionAccount(pool, provisionInput({ phoneFingerprint: fp2 }));
    await pool.query(
      "UPDATE core.user_profile SET phone_verified_at = now() - interval '30 days' WHERE id = $1",
      [established.userId],
    );
    const late = await signedIn();
    expect(await codeOf(claim(late.sessionId, fp2))).toBe("CONFLICT");
  });

  it("major 1 (c): distinct numbers per account: 3 new per day; repeats are free; 5 in all until onboarding completes", async () => {
    const a = await signedIn();
    const fps = Array.from({ length: 7 }, () => randomBytes(32));
    const attempt = (fp: Buffer) =>
      phoneNumberAttempt(pool, { authSessionId: a.sessionId, phoneFingerprint: fp });
    expect([
      await attempt(fps[0] as Buffer),
      await attempt(fps[1] as Buffer),
      await attempt(fps[2] as Buffer),
    ]).toEqual(["NEW", "NEW", "NEW"]);
    expect(await attempt(fps[0] as Buffer)).toBe("KNOWN");
    expect(await attempt(fps[3] as Buffer)).toBe("LIMIT");
    // a day later: two more, then the lifetime cap
    await pool.query(
      "UPDATE core.phone_attempt SET first_at = first_at - interval '25 hours' WHERE user_id = $1",
      [a.userId],
    );
    expect(await attempt(fps[3] as Buffer)).toBe("NEW");
    expect(await attempt(fps[4] as Buffer)).toBe("NEW");
    expect(await attempt(fps[5] as Buffer)).toBe("LIMIT");
    // a provisioned account is held to the daily cap only
    const p = await provisionAccount(pool, provisionInput());
    for (let i = 0; i < 6; i++) {
      await pool.query(
        "UPDATE core.phone_attempt SET first_at = first_at - interval '25 hours' WHERE user_id = $1",
        [p.userId],
      );
      expect(
        await phoneNumberAttempt(pool, { authSessionId: p.authSessionId, phoneFingerprint: randomBytes(32) }),
      ).toBe("NEW");
    }
  });

  it("major 1 (b): holds older than the code lifetime are listed for the job runner and removed when done", async () => {
    const a = await signedIn();
    const fp = randomBytes(32);
    await phoneHoldSet(pool, { authSessionId: a.sessionId, phoneFingerprint: fp });
    const listed = async () => (await expiredPhoneHolds(pool, 100)).filter((h) => h.userId === a.userId);
    expect(await listed()).toEqual([]);
    await pool.query("UPDATE core.phone_hold SET set_at = now() - interval '11 minutes' WHERE user_id = $1", [
      a.userId,
    ]);
    // resending the same number does not restart the hold
    await phoneHoldSet(pool, { authSessionId: a.sessionId, phoneFingerprint: fp });
    const [hold] = await listed();
    expect(hold?.phoneFingerprint.equals(fp)).toBe(true);
    if (hold) await phoneHoldDone(pool, hold);
    expect(await listed()).toEqual([]);
    // a confirmed number ends the hold
    await phoneHoldSet(pool, { authSessionId: a.sessionId, phoneFingerprint: fp });
    await claim(a.sessionId, fp);
    expect(
      Number(
        (await pool.query("SELECT count(*) AS n FROM core.phone_hold WHERE user_id = $1", [a.userId])).rows[0]
          ?.n,
      ),
    ).toBe(0);
    // the local stand-in keeps no numbers: there is never a holder to name
    expect(
      await authPhoneHolder(pool, {
        authSessionId: a.sessionId,
        phoneDigits: "919876543210",
        phoneFingerprint: fp,
      }),
    ).toBeNull();
  });

  it("major 1: the bookkeeping is owner-only; each function is executable only by its one role", async () => {
    const { userId } = await signedIn();
    const fp = randomBytes(32);
    for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
      for (const t of ["core.phone_attempt", "core.phone_hold"]) {
        expect(await stateOf(pool, `SELECT * FROM ${t}`, [], { role, userId }), `${role} ${t}`).toBe("42501");
      }
    }
    const calls: [string, unknown[], string][] = [
      ["SELECT core.phone_number_attempt($1)", [fp], "app_web"],
      ["SELECT core.phone_hold_set($1)", [fp], "app_web"],
      ["SELECT core.auth_phone_holder('919876543210', $1)", [fp], "app_web"],
      ["SELECT * FROM core.phone_holds_expired(10)", [], "app_jobs"],
      ["SELECT core.phone_hold_done($1, $2)", [userId, fp], "app_jobs"],
      ["SELECT core.phone_claim_release($1)", [userId], "none"],
    ];
    for (const [sql, params, allowed] of calls) {
      for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        const state = await stateOf(pool, sql, params, { role, userId });
        if (role === allowed) expect(state, `${role}: ${sql}`).not.toBe("42501");
        else expect(state, `${role}: ${sql}`).toBe("42501");
      }
    }
  });
});
