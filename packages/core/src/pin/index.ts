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

function weak(reason: PinWeakReason, message: string): PinCheck {
  return { ok: false, error: new DomainError("PIN_WEAK", message, { reason }) };
}

/** Validate a PIN at set/change time. Returns a PIN_WEAK DomainError (details.reason) when rejected. */
export function validateNewPin(pin: string, birthdate: string): PinCheck {
  if (!PIN_FORMAT.test(pin)) return weak("FORMAT", "PIN must be exactly six digits");
  if (/^(\d)\1{5}$/.test(pin)) return weak("REPEATED", "PIN cannot be one digit repeated");
  if (isSequential(pin)) return weak("SEQUENTIAL", "PIN cannot be a sequence");
  if (COMMON_PINS.has(pin)) return weak("COMMON", "PIN is too common");
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
