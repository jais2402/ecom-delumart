import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyPinAttempt,
  birthdatePinForms,
  hashPin,
  INITIAL_PIN_ATTEMPT_STATE,
  type PinAttemptState,
  type PinHashOptions,
  validateNewPin,
  verifyPin,
} from "./index";

const BIRTHDATE = "1999-08-15";

function reason(pin: string, birthdate = BIRTHDATE): string | undefined {
  const r = validateNewPin(pin, birthdate);
  if (r.ok) return undefined;
  expect(r.error.code).toBe("PIN_WEAK");
  return r.error.details.reason as string;
}

describe("validateNewPin (US-48)", () => {
  it("US-48: rejects 123456 and 111111", () => {
    expect(reason("123456")).toBe("SEQUENTIAL");
    expect(reason("111111")).toBe("REPEATED");
  });

  it("US-48: rejects every arrangement of the player's birthdate digits", () => {
    for (const pin of ["150899", "081599", "990815", "991508", "150819", "081999", "199908"]) {
      expect(reason(pin), pin).toBe("BIRTHDATE");
    }
    expect([...birthdatePinForms(BIRTHDATE)].sort()).toEqual(
      expect.arrayContaining(["150899", "081599", "990815", "991508", "150819", "081999", "199908"]),
    );
  });

  it("rejects anything that is not exactly six digits", () => {
    for (const pin of ["", "12345", "1234567", "12a456", " 48261", "４８２６１９"]) {
      expect(reason(pin)).toBe("FORMAT");
    }
  });

  it("rejects ascending and descending sequences", () => {
    for (const pin of ["012345", "345678", "456789", "987654", "543210"])
      expect(reason(pin)).toBe("SEQUENTIAL");
  });

  it("rejects common PINs from the deny-list", () => {
    for (const pin of ["123123", "112233", "121212", "159753"]) expect(reason(pin)).toBe("COMMON");
  });

  it("accepts an unremarkable PIN", () => {
    expect(validateNewPin("482619", BIRTHDATE)).toEqual({ ok: true });
  });

  it("all-same six digits are always rejected (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9 }), (d) => {
        expect(reason(String(d).repeat(6))).toBe("REPEATED");
      }),
    );
  });

  it("birthdate forms are always rejected for any birthdate (property)", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("1900-01-01"), max: new Date("2025-12-31"), noInvalidDate: true }),
        (d) => {
          const iso = d.toISOString().slice(0, 10);
          const [y, m, dd] = iso.split("-") as [string, string, string];
          const yy = y.slice(2);
          for (const pin of [dd + m + yy, m + dd + yy, yy + m + dd, yy + dd + m]) {
            expect(validateNewPin(pin, iso).ok).toBe(false);
          }
        },
      ),
    );
  });
});

describe("applyPinAttempt (US-48)", () => {
  const MIN = 60_000;
  const t0 = 1_800_000_000_000;

  function run(state: PinAttemptState, correct: boolean[], now = t0) {
    let s = state;
    const results = [];
    for (const c of correct) {
      const r = applyPinAttempt(s, { correct: c, now });
      s = r.state;
      results.push(r.result);
    }
    return { state: s, results };
  }

  it("a correct PIN passes and resets the failure counter", () => {
    const { state, results } = run(INITIAL_PIN_ATTEMPT_STATE, [false, false, true]);
    expect(results.at(-1)).toEqual({ ok: true });
    expect(state.consecutiveFailures).toBe(0);
  });

  it("a wrong PIN increments the counter and returns PIN_INCORRECT", () => {
    const { state, results } = run(INITIAL_PIN_ATTEMPT_STATE, [false]);
    expect(results[0]).toEqual({ ok: false, code: "PIN_INCORRECT", remainingBeforeLock: 4 });
    expect(state.consecutiveFailures).toBe(1);
  });

  it("US-48: the fifth consecutive wrong PIN locks card payments for 15 minutes", () => {
    const { state, results } = run(INITIAL_PIN_ATTEMPT_STATE, [false, false, false, false, false]);
    expect(results[3]).toMatchObject({ ok: false, code: "PIN_INCORRECT" });
    expect(results[4]).toEqual({ ok: false, code: "PIN_LOCKED", lockedUntil: t0 + 15 * MIN });
    expect(state.lockedUntil).toBe(t0 + 15 * MIN);
  });

  it("US-48: while locked even the correct PIN is refused; at lockedUntil it is accepted", () => {
    const locked: PinAttemptState = { consecutiveFailures: 0, lockedUntil: t0 + 15 * MIN };
    expect(applyPinAttempt(locked, { correct: true, now: t0 + 15 * MIN - 1 }).result).toMatchObject({
      code: "PIN_LOCKED",
    });
    const after = applyPinAttempt(locked, { correct: true, now: t0 + 15 * MIN });
    expect(after.result).toEqual({ ok: true });
    expect(after.state).toEqual(INITIAL_PIN_ATTEMPT_STATE);
  });

  it("a locked attempt does not change the state", () => {
    const locked: PinAttemptState = { consecutiveFailures: 0, lockedUntil: t0 + MIN };
    expect(applyPinAttempt(locked, { correct: false, now: t0 }).state).toEqual(locked);
  });

  it("never locks before five consecutive failures (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 40 }), (attempts) => {
        let s = INITIAL_PIN_ATTEMPT_STATE;
        let streak = 0;
        for (const c of attempts) {
          const r = applyPinAttempt(s, { correct: c, now: t0 });
          if (s.lockedUntil !== null && s.lockedUntil > t0) {
            expect(r.result).toMatchObject({ code: "PIN_LOCKED" });
          } else {
            streak = c ? 0 : streak + 1;
            if (streak === 5) {
              expect(r.state.lockedUntil).toBe(t0 + 15 * MIN);
              streak = 0;
            } else {
              expect(r.state.lockedUntil === null || r.state.lockedUntil <= t0).toBe(true);
            }
          }
          s = r.state;
        }
      }),
    );
  });
});

describe("hashPin / verifyPin", () => {
  const opts: PinHashOptions = {
    pepper: new TextEncoder().encode("test-pepper"),
    salt: new Uint8Array(16).fill(7),
    argon2: { t: 1, m: 64, p: 1 },
  };

  it("verifies the right PIN and rejects a wrong one", () => {
    const hash = hashPin("482619", opts);
    expect(verifyPin("482619", hash, opts)).toBe(true);
    expect(verifyPin("482618", hash, opts)).toBe(false);
  });

  it("the hash depends on salt and pepper and does not contain the PIN", () => {
    const hash = hashPin("482619", opts);
    expect(hashPin("482619", { ...opts, salt: new Uint8Array(16).fill(8) })).not.toEqual(hash);
    expect(hashPin("482619", { ...opts, pepper: new TextEncoder().encode("other") })).not.toEqual(hash);
    expect(new TextDecoder().decode(hash)).not.toContain("482619");
  });

  it("verify returns false for a hash of a different length", () => {
    expect(verifyPin("482619", new Uint8Array(5), opts)).toBe(false);
  });
});
