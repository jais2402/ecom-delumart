/**
 * Delulu card commands (LLD §5.5, US-48, US-15) through the functions of migration 0025, as the
 * money-command role app_pay. Only pin_mac = HMAC-SHA-256(PIN_PEPPER, pin) (32 bytes) is sent:
 * the database never sees a PIN. Check the PIN rules (packages/core/src/pin) before computing it.
 *
 * A wrong PIN is not raised by the database, so that its counters commit: these wrappers commit
 * and then throw the DomainError (PIN_INCORRECT with details.remainingTries, CHALLENGE_LOCKED,
 * PIN_LOCKED).
 */
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { asPay, requireUuid } from "./command";

export type CardStatus = "ACTIVE" | "FROZEN" | "REPLACED";

function requireMac(value: unknown, field: string): void {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new DomainError("VALIDATION_FAILED", `${field} is a 32-byte HMAC`, { field });
  }
}

interface PinOutcome {
  status: string;
  remaining_tries: number | null;
}

function throwUnlessOk(outcome: PinOutcome | undefined, ok: string): void {
  if (!outcome) throw new Error("PIN command returned nothing");
  if (outcome.status === ok) return;
  const remainingTries = outcome.remaining_tries ?? 0;
  switch (outcome.status) {
    case "PIN_INCORRECT":
      throw new DomainError("PIN_INCORRECT", "That PIN is not right.", { remainingTries });
    case "CHALLENGE_LOCKED":
      throw new DomainError("CHALLENGE_LOCKED", "Too many wrong PINs for this payment.", { remainingTries });
    case "PIN_LOCKED":
      throw new DomainError("PIN_LOCKED", "Too many wrong PINs; the card is locked for a while.", {
        remainingTries,
      });
    default:
      throw new Error("unknown PIN outcome");
  }
}

export interface SetCardPinInput {
  authSessionId: string;
  cardId: string;
  pinMac: Buffer;
  /** Required when the card already has a PIN. */
  currentPinMac?: Buffer | null;
}

/** Sets the card's first PIN, or changes it given the current one (a wrong one counts). */
export async function setCardPin(pool: Pool, input: SetCardPinInput): Promise<void> {
  requireUuid(input.cardId, "cardId");
  requireMac(input.pinMac, "pinMac");
  if (input.currentPinMac != null) requireMac(input.currentPinMac, "currentPinMac");
  const outcome = await asPay(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<PinOutcome>("SELECT * FROM core.set_card_pin($1, $2, $3)", [
      input.cardId,
      input.pinMac,
      input.currentPinMac ?? null,
    ]);
    return rows[0];
  });
  throwUnlessOk(outcome, "PIN_SET");
}

/** Sets a new PIN without the current one; needs a sign-in within five minutes (REAUTH_REQUIRED). */
export async function resetCardPin(
  pool: Pool,
  input: { authSessionId: string; cardId: string; pinMac: Buffer },
): Promise<void> {
  requireUuid(input.cardId, "cardId");
  requireMac(input.pinMac, "pinMac");
  await asPay(pool, input.authSessionId, async (c) => {
    await c.query("SELECT core.reset_card_pin($1, $2)", [input.cardId, input.pinMac]);
  });
}

/** The PIN step of a CARD payment attempt: the only way such an attempt is authenticated. */
export async function verifyCardPin(
  pool: Pool,
  input: { authSessionId: string; attemptId: string; pinMac: Buffer },
): Promise<void> {
  requireUuid(input.attemptId, "attemptId");
  requireMac(input.pinMac, "pinMac");
  const outcome = await asPay(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<PinOutcome>("SELECT * FROM core.verify_card_pin($1, $2)", [
      input.attemptId,
      input.pinMac,
    ]);
    return rows[0];
  });
  throwUnlessOk(outcome, "AUTHENTICATED");
}

/** Freezes or unfreezes the caller's own card; returns its status. */
export async function setCardFrozen(
  pool: Pool,
  input: { authSessionId: string; cardId: string; frozen: boolean },
): Promise<CardStatus> {
  requireUuid(input.cardId, "cardId");
  if (typeof input.frozen !== "boolean") throw new DomainError("VALIDATION_FAILED", "frozen is a boolean");
  return asPay(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ s: CardStatus }>("SELECT core.set_card_frozen($1, $2) AS s", [
      input.cardId,
      input.frozen,
    ]);
    const s = rows[0]?.s;
    if (!s) throw new Error("set_card_frozen returned nothing");
    return s;
  });
}
