/**
 * Delulu PIN rules (LLD §5.5, US-48): weak-PIN rejection, the attempt/lockout reducer, and hashing.
 * Pure: the clock, salt and pepper are parameters.
 */
import { argon2id } from "@noble/hashes/argon2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { DomainError } from "../errors/index";

export type PinWeakReason = "FORMAT" | "REPEATED" | "SEQUENTIAL" | "COMMON" | "BIRTHDATE";
export type PinCheck = { ok: true } | { ok: false; error: DomainError };

/** Commonly chosen six-digit PINs (all-same and straight sequences are rejected separately). */
export const COMMON_PINS: ReadonlySet<string> = new Set([
  "123123",
  "321321",
  "112233",
  "332211",
  "121212",
  "212121",
  "131313",
  "232323",
  "101010",
  "202020",
  "123321",
  "654456",
  "111222",
  "222111",
  "112211",
  "100200",
  "102030",
  "007007",
  "786786",
  "420420",
  "696969",
  "159753",
  "357159",
  "147258",
  "258369",
  "963852",
  "741852",
  "147852",
  "159357",
  "789456",
  "456123",
  "123654",
  "520520",
  "520131",
  "456456",
  "789789",
  "000111",
  "111000",
  "998877",
  "666999",
]);

const PIN_FORMAT = /^[0-9]{6}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Every six-digit arrangement of a YYYY-MM-DD birthdate that a PIN must not equal. */
export function birthdatePinForms(birthdate: string): Set<string> {
  const m = ISO_DATE.exec(birthdate);
  if (!m) throw new DomainError("VALIDATION_FAILED", "birthdate must be YYYY-MM-DD");
  const [, yyyy = "", mm = "", dd = ""] = m;
  const yy = yyyy.slice(2);
  const forms = new Set<string>([
    // all orderings of DD, MM, YY (covers DDMMYY, MMDDYY, YYMMDD, YYDDMM and the other two)
    dd + mm + yy,
    dd + yy + mm,
    mm + dd + yy,
    mm + yy + dd,
    yy + mm + dd,
    yy + dd + mm,
  ]);
  for (const eight of [dd + mm + yyyy, mm + dd + yyyy, yyyy + mm + dd, yyyy + dd + mm]) {
    forms.add(eight.slice(0, 6));
    forms.add(eight.slice(2));
  }
  return forms;
}

function isSequential(pin: string): boolean {
  const steps = new Set<number>();
  for (let i = 1; i < pin.length; i++) steps.add(pin.charCodeAt(i) - pin.charCodeAt(i - 1));
  return steps.size === 1 && (steps.has(1) || steps.has(-1));
}

/** Generic weak-PIN pattern limits (configuration). */
export type PinRulesConfig = {
  /** Reject a PIN in which any one digit appears at least this many times. */
  maxSameDigit: number;
  /** Reject a PIN containing a run of at least this many digits with a constant non-zero step (mod 10). */
  minSteppedRun: number;
};
export const DEFAULT_PIN_RULES_CONFIG: PinRulesConfig = { maxSameDigit: 5, minSteppedRun: 5 };

/** ABABAB or ABCABC: the PIN is a shorter block repeated. */
function isRepeatedBlock(pin: string): boolean {
  for (let size = 1; size < pin.length; size++) {
    if (pin.length % size === 0 && pin.slice(0, size).repeat(pin.length / size) === pin) return true;
  }
  return false;
}

function maxDigitCount(pin: string): number {
  const counts = new Map<string, number>();
  for (const ch of pin) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return Math.max(...counts.values());
}

/**
 * Longest run of digits with a constant non-zero step modulo 10, so ascending and descending runs wrap
 * around (890123, 098765) and stepped runs count (246802, 13579 in 135790).
 */
function longestSteppedRun(pin: string): number {
  let best = 1;
  let run = 1;
  let prevStep: number | null = null;
  for (let i = 1; i < pin.length; i++) {
    const step = (pin.charCodeAt(i) - pin.charCodeAt(i - 1) + 10) % 10;
    if (step !== 0 && step === prevStep) run++;
    else run = step === 0 ? 1 : 2;
    prevStep = step;
    best = Math.max(best, run);
  }
  return best;
}

function weak(reason: PinWeakReason, message: string): PinCheck {
  return { ok: false, error: new DomainError("PIN_WEAK", message, { reason }) };
}

/** Validate a PIN at set/change time. Returns a PIN_WEAK DomainError (details.reason) when rejected. */
export function validateNewPin(
  pin: string,
  birthdate: string,
  cfg: PinRulesConfig = DEFAULT_PIN_RULES_CONFIG,
): PinCheck {
  if (!PIN_FORMAT.test(pin)) return weak("FORMAT", "PIN must be exactly six digits");
  if (/^(\d)\1{5}$/.test(pin)) return weak("REPEATED", "PIN cannot be one digit repeated");
  if (isSequential(pin)) return weak("SEQUENTIAL", "PIN cannot be a sequence");
  if (COMMON_PINS.has(pin)) return weak("COMMON", "PIN is too common");
  if (isRepeatedBlock(pin)) return weak("REPEATED", "PIN cannot be a repeated pattern");
  if (maxDigitCount(pin) >= cfg.maxSameDigit) return weak("REPEATED", "PIN repeats one digit too often");
  if (longestSteppedRun(pin) >= cfg.minSteppedRun) return weak("SEQUENTIAL", "PIN cannot be a sequence");
  if (birthdatePinForms(birthdate).has(pin)) return weak("BIRTHDATE", "PIN cannot be your birthdate");
  return { ok: true };
}

// ---------- attempt counter ----------

export type PinAttemptState = {
  consecutiveFailures: number;
  /** Epoch milliseconds, or null when not locked. */
  lockedUntil: number | null;
};

export type PinAttemptConfig = { maxConsecutiveFailures: number; lockMs: number };
export const DEFAULT_PIN_ATTEMPT_CONFIG: PinAttemptConfig = {
  maxConsecutiveFailures: 5,
  lockMs: 15 * 60_000,
};
export const INITIAL_PIN_ATTEMPT_STATE: PinAttemptState = { consecutiveFailures: 0, lockedUntil: null };

export type PinAttemptResult =
  | { ok: true }
  | { ok: false; code: "PIN_INCORRECT"; remainingBeforeLock: number }
  | { ok: false; code: "PIN_LOCKED"; lockedUntil: number };

/**
 * Reducer for one PIN verification, run under the card lock.
 * - locked (lockedUntil > now): refused with PIN_LOCKED, state unchanged;
 * - wrong: consecutive failures +1; the fifth sets lockedUntil = now + 15 min and restarts the count;
 * - correct: counter reset.
 */
export function applyPinAttempt(
  state: PinAttemptState,
  attempt: { correct: boolean; now: number },
  cfg: PinAttemptConfig = DEFAULT_PIN_ATTEMPT_CONFIG,
): { state: PinAttemptState; result: PinAttemptResult } {
  const { now } = attempt;
  if (state.lockedUntil !== null && state.lockedUntil > now) {
    return { state, result: { ok: false, code: "PIN_LOCKED", lockedUntil: state.lockedUntil } };
  }
  if (attempt.correct) return { state: INITIAL_PIN_ATTEMPT_STATE, result: { ok: true } };
  const failures = state.consecutiveFailures + 1;
  if (failures >= cfg.maxConsecutiveFailures) {
    const lockedUntil = now + cfg.lockMs;
    return {
      state: { consecutiveFailures: 0, lockedUntil },
      result: { ok: false, code: "PIN_LOCKED", lockedUntil },
    };
  }
  return {
    state: { consecutiveFailures: failures, lockedUntil: null },
    result: { ok: false, code: "PIN_INCORRECT", remainingBeforeLock: cfg.maxConsecutiveFailures - failures },
  };
}

// ---------- per-payment challenge ----------

/** One PIN challenge belongs to one payment attempt; it is single use. */
export type ChallengeState = {
  status: "OPEN" | "PASSED" | "FAILED";
  wrongAttempts: number;
};
export type ChallengeConfig = { maxWrongPerChallenge: number };
export const DEFAULT_CHALLENGE_CONFIG: ChallengeConfig = { maxWrongPerChallenge: 3 };
export const INITIAL_CHALLENGE_STATE: ChallengeState = { status: "OPEN", wrongAttempts: 0 };

export type ChallengeResult =
  | { status: "PASSED" }
  | { status: "RETRY"; remainingTries: number }
  | { status: "FAILED" };

/**
 * Reducer for one PIN entry within a payment attempt (US-48): correct → PASSED; wrong → RETRY with the
 * tries left, and the third wrong (configurable) → FAILED, which fails the attempt with no debit.
 * A PASSED or FAILED challenge is final. This is separate from the card-level lockout
 * (`applyPinAttempt`); callers run both for every PIN entry.
 */
export function applyChallengeAttempt(
  state: ChallengeState,
  attempt: { correct: boolean },
  cfg: ChallengeConfig = DEFAULT_CHALLENGE_CONFIG,
): { state: ChallengeState; result: ChallengeResult } {
  if (state.status !== "OPEN") return { state, result: { status: state.status } };
  if (attempt.correct) {
    return { state: { ...state, status: "PASSED" }, result: { status: "PASSED" } };
  }
  const wrongAttempts = state.wrongAttempts + 1;
  if (wrongAttempts >= cfg.maxWrongPerChallenge) {
    return { state: { status: "FAILED", wrongAttempts }, result: { status: "FAILED" } };
  }
  return {
    state: { status: "OPEN", wrongAttempts },
    result: { status: "RETRY", remainingTries: cfg.maxWrongPerChallenge - wrongAttempts },
  };
}

// ---------- hashing ----------

export type PinHashOptions = {
  /** PIN_PEPPER from the secret store. */
  pepper: Uint8Array;
  /** Per-PIN random salt (≥ 16 bytes), generated by the caller and stored beside the hash. */
  salt: Uint8Array;
  /**
   * Argon2id cost. Production: { t: 2, m: 19_456 (KiB), p: 1 } (OWASP minimum) or stronger, from configuration.
   * Tests use tiny values so they run fast.
   */
  argon2: { t: number; m: number; p: number; dkLen?: number };
};

/** Argon2id(HMAC-SHA-256(PIN_PEPPER, pin), salt). */
export function hashPin(pin: string, opts: PinHashOptions): Uint8Array {
  const peppered = hmac(sha256, opts.pepper, utf8ToBytes(pin));
  return argon2id(peppered, opts.salt, { dkLen: 32, ...opts.argon2 });
}

/** Constant-time byte comparison (time depends only on length). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function verifyPin(pin: string, storedHash: Uint8Array, opts: PinHashOptions): boolean {
  return constantTimeEqual(hashPin(pin, opts), storedHash);
}
