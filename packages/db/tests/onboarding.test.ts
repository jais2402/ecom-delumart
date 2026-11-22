import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { onboardingStatus, recordBirthdate, recordPhoneVerified } from "../src/onboarding";
import { provisionAccount as provisionAs } from "../src/provision";
import {
  countRows,
  createTestDatabase,
  provisionAccount,
  provisionInput,
  sessionFor,
  stateOf,
  type TestDatabase,
  type TestProvisionInput,
  uuidv7,
} from "./helpers";

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? "unknown",
  );
const messageOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

const NOTHING = {
  hasProfile: false,
  phoneVerified: false,
  phoneRecorded: false,
  phoneReverifyRequired: false,
  hasBirthdate: false,
  isAdult: false,
  provisioned: false,
  pinSet: false,
};

describe("onboarding (LLD §7.1): phone, birthdate, then provisioning", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  });
  afterAll(async () => {
    await db.drop();
  });

  /** A user the sign-in service knows, with a live session, and nothing else. */
  async function signedIn(): Promise<{ input: TestProvisionInput; authSessionId: string }> {
    const input = provisionInput();
    return { input, authSessionId: await sessionFor(pool, input.userId) };
  }
  const phone = (u: { input: TestProvisionInput; authSessionId: string }) =>
    recordPhoneVerified(pool, {
      authSessionId: u.authSessionId,
      phoneFingerprint: u.input.phoneFingerprint ?? Buffer.alloc(0),
      emailFingerprint: u.input.emailFingerprint,
    });
  const birthdate = (u: { input: TestProvisionInput; authSessionId: string }, isAdult = true) =>
    recordBirthdate(pool, { authSessionId: u.authSessionId, birthdateEnc: u.input.birthdateEnc, isAdult });
  const provision = (u: { input: TestProvisionInput; authSessionId: string }) =>
    provisionAs(pool, {
      authSessionId: u.authSessionId,
      emailFingerprint: u.input.emailFingerprint,
      phoneFingerprint: u.input.phoneFingerprint,
      cardNumbers: u.input.cardNumbers,
      alias: u.input.alias,
      upiStyleId: u.input.upiStyleId,
    });

  it("US-01: the step flags follow the user through phone, birthdate, provisioning", async () => {
    const u = await signedIn();
    expect(await onboardingStatus(pool, u)).toEqual(NOTHING);
    expect(await phone(u)).toEqual({
      ...NOTHING,
      hasProfile: true,
      phoneVerified: true,
      phoneRecorded: true,
    });
    expect(await birthdate(u)).toEqual({
      ...NOTHING,
      hasProfile: true,
      phoneVerified: true,
      phoneRecorded: true,
      hasBirthdate: true,
      isAdult: true,
    });
    const r = await provision(u);
    expect(r.created).toBe(true);
    expect(await onboardingStatus(pool, u)).toEqual({
      hasProfile: true,
      phoneVerified: true,
      phoneRecorded: true,
      phoneReverifyRequired: false,
      hasBirthdate: true,
      isAdult: true,
      provisioned: true,
      pinSet: false,
    });
  });

  it("US-01: no grant, bank account or card before the phone is verified (PHONE_REQUIRED), and no profile either", async () => {
    const u = await signedIn();
    expect(await codeOf(provision(u))).toBe("PHONE_REQUIRED");
    expect(await codeOf(birthdate(u))).toBe("PHONE_REQUIRED");
    expect(
      await countRows(pool, "SELECT count(*) AS n FROM core.user_profile WHERE id = $1", [u.input.userId]),
    ).toBe(0);
  });

  it("US-01: provisioning needs the birthdate recorded", async () => {
    const u = await signedIn();
    await phone(u);
    expect(await codeOf(provision(u))).toBe("VALIDATION_FAILED");
    expect(
      await countRows(pool, "SELECT count(*) AS n FROM ledger.ledger_account WHERE user_id = $1", [
        u.input.userId,
      ]),
    ).toBe(0);
  });

  it("a minor is recorded once and refused provisioning (UNDERAGE); another birthdate cannot be tried", async () => {
    const u = await signedIn();
    await phone(u);
    expect(await codeOf(birthdate(u, false))).toBe("UNDERAGE");
    expect(await onboardingStatus(pool, u)).toMatchObject({ hasBirthdate: true, isAdult: false });
    expect(await codeOf(provision(u))).toBe("UNDERAGE");
    expect(
      await codeOf(
        recordBirthdate(pool, {
          authSessionId: u.authSessionId,
          birthdateEnc: randomBytes(40),
          isAdult: true,
        }),
      ),
    ).toBe("CONFLICT");
    expect(
      await codeOf(
        recordBirthdate(pool, {
          authSessionId: u.authSessionId,
          birthdateEnc: u.input.birthdateEnc,
          isAdult: true,
        }),
      ),
    ).toBe("CONFLICT");
    expect(
      await countRows(pool, "SELECT count(*) AS n FROM ledger.grant_record WHERE user_id = $1", [
        u.input.userId,
      ]),
    ).toBe(0);
  });

  it("the birthdate is stored once: the same call again is answered, a different one is CONFLICT, and no application role can rewrite it", async () => {
    const u = await signedIn();
    await phone(u);
    await birthdate(u);
    expect(await codeOf(birthdate(u))).toBe("ok");
    expect(
      await codeOf(
        recordBirthdate(pool, {
          authSessionId: u.authSessionId,
          birthdateEnc: randomBytes(40),
          isAdult: true,
        }),
      ),
    ).toBe("CONFLICT");
    for (const role of ["app_web", "app_pay"]) {
      const as = { role, userId: u.input.userId };
      expect(
        await stateOf(
          pool,
          "UPDATE private.user_secret SET birthdate_enc = '\\x00' WHERE user_id = $1",
          [u.input.userId],
          as,
        ),
        role,
      ).toBe("42501");
      expect(
        await stateOf(
          pool,
          "INSERT INTO private.user_secret (user_id, birthdate_enc) VALUES ($1, '\\x00')",
          [uuidv7()],
          as,
        ),
        role,
      ).toBe("42501");
    }
    const { rows } = await pool.query<{ b: Buffer }>(
      "SELECT birthdate_enc AS b FROM private.user_secret WHERE user_id = $1",
      [u.input.userId],
    );
    expect(rows[0]?.b.equals(u.input.birthdateEnc)).toBe(true);
    // the owner role can still correct it
    expect(
      await stateOf(pool, "UPDATE private.user_secret SET birthdate_enc = '\\x01' WHERE user_id = $1", [
        u.input.userId,
      ]),
    ).toBe("no error");
  });

  it("the phone step creates the profile with the given email fingerprint; an existing profile keeps its own", async () => {
    const u = await signedIn();
    await phone(u);
    const again = await recordPhoneVerified(pool, {
      authSessionId: u.authSessionId,
      phoneFingerprint: u.input.phoneFingerprint ?? Buffer.alloc(0),
      emailFingerprint: randomBytes(32),
    });
    expect(again.phoneVerified).toBe(true);
    const { rows } = await pool.query<{ e: Buffer; p: Buffer; at: Date | null }>(
      "SELECT email_fingerprint AS e, phone_fingerprint AS p, phone_verified_at AS at FROM core.user_profile WHERE id = $1",
      [u.input.userId],
    );
    expect(rows[0]?.e.equals(u.input.emailFingerprint)).toBe(true);
    expect(rows[0]?.p.equals(u.input.phoneFingerprint ?? Buffer.alloc(0))).toBe(true);
    expect(rows[0]?.at).not.toBeNull();
  });

  it("US-49: a phone or email fingerprint of another account is one uniform CONFLICT; two racing sign-ups with one number give one winner", async () => {
    const holder = await provisionAccount(pool, provisionInput());
    const held = await pool.query<{ e: Buffer; p: Buffer }>(
      "SELECT email_fingerprint AS e, phone_fingerprint AS p FROM core.user_profile WHERE id = $1",
      [holder.userId],
    );
    const fp = held.rows[0];
    if (!fp) throw new Error("fixture");
    const u1 = await signedIn();
    const byPhone = await messageOf(
      recordPhoneVerified(pool, {
        authSessionId: u1.authSessionId,
        phoneFingerprint: fp.p,
        emailFingerprint: randomBytes(32),
      }),
    );
    const u2 = await signedIn();
    const byEmail = await messageOf(
      recordPhoneVerified(pool, {
        authSessionId: u2.authSessionId,
        phoneFingerprint: randomBytes(32),
        emailFingerprint: fp.e,
      }),
    );
    expect(byPhone).toBe(byEmail);
    expect(
      await codeOf(
        recordPhoneVerified(pool, {
          authSessionId: u2.authSessionId,
          phoneFingerprint: fp.p,
          emailFingerprint: fp.e,
        }),
      ),
    ).toBe("CONFLICT");

    const contested = randomBytes(32);
    const racers = await Promise.all(Array.from({ length: 4 }, () => signedIn()));
    const outcomes = await Promise.all(
      racers.map((r) =>
        codeOf(
          recordPhoneVerified(pool, {
            authSessionId: r.authSessionId,
            phoneFingerprint: contested,
            emailFingerprint: r.input.emailFingerprint,
          }),
        ),
      ),
    );
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "CONFLICT")).toHaveLength(3);
  });

  it("changing the phone of a provisioned account needs a sign-in within the last five minutes", async () => {
    const user = await provisionAccount(pool, provisionInput());
    await pool.query("UPDATE auth.sessions SET created_at = now() - interval '10 minutes' WHERE id = $1", [
      user.authSessionId,
    ]);
    const change = () =>
      recordPhoneVerified(pool, {
        authSessionId: user.authSessionId,
        phoneFingerprint: randomBytes(32),
        emailFingerprint: randomBytes(32),
      });
    expect(await codeOf(change())).toBe("REAUTH_REQUIRED");
    await pool.query("UPDATE auth.sessions SET created_at = now() WHERE id = $1", [user.authSessionId]);
    expect(await codeOf(change())).toBe("ok");
  });

  it("every step refuses without a signed-in session, and only app_pay may call them", async () => {
    const guess = uuidv7();
    expect(await codeOf(onboardingStatus(pool, { authSessionId: guess }))).toBe("FORBIDDEN");
    expect(
      await codeOf(
        recordPhoneVerified(pool, {
          authSessionId: guess,
          phoneFingerprint: randomBytes(32),
          emailFingerprint: randomBytes(32),
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        recordBirthdate(pool, { authSessionId: guess, birthdateEnc: randomBytes(40), isAdult: true }),
      ),
    ).toBe("FORBIDDEN");
    const u = await signedIn();
    for (const sql of [
      "SELECT * FROM core.onboarding_status()",
      "SELECT core.record_phone_verified($1, $1)",
      "SELECT core.record_birthdate($1, true)",
    ]) {
      const params = sql.includes("$1") ? [randomBytes(32)] : [];
      for (const role of ["app_web", "app_jobs"]) {
        expect(await stateOf(pool, sql, params, { role, userId: u.input.userId }), `${role} ${sql}`).toBe(
          "42501",
        );
      }
    }
  });

  it("the status carries flags only: no fingerprint, birthdate or other personal data", async () => {
    const u = await signedIn();
    const status = await phone(u);
    expect(Object.keys(status).sort()).toEqual(Object.keys(NOTHING).sort());
    expect(Object.values(status).every((v) => typeof v === "boolean")).toBe(true);
  });
});

describe("onboarding: when the sign-in service records phone confirmation, the database requires it", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    // as on Supabase: the auth schema exists before the migrations, with phone_confirmed_at
    await db.pool.query(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY, banned_until timestamptz, deleted_at timestamptz,
        phone_confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id),
        not_after timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now());`);
    await migrate(db.pool);
  });
  afterAll(async () => {
    await db.drop();
  });

  it("a phone the sign-in service has not confirmed cannot be recorded verified (PHONE_REQUIRED)", async () => {
    const input = provisionInput();
    const authSessionId = await sessionFor(db.pool, input.userId);
    const record = () =>
      recordPhoneVerified(db.pool, {
        authSessionId,
        phoneFingerprint: input.phoneFingerprint ?? Buffer.alloc(0),
        emailFingerprint: input.emailFingerprint,
      });
    expect(await codeOf(record())).toBe("PHONE_REQUIRED");
    await db.pool.query("UPDATE auth.users SET phone_confirmed_at = now() WHERE id = $1", [input.userId]);
    expect((await record()).phoneVerified).toBe(true);
  });
});
