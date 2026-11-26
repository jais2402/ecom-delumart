import type { ScreenCode } from "./index";

/**
 * Review round 1, major M1: text that slipped past the screening rules, shared by the core,
 * database and web tests (listings, stores and reviews all screen with the same rules). Each is
 * refused with the code given.
 */
export const BYPASS_ATTACKS: readonly (readonly [text: string, code: ScreenCode])[] = [
  ["९८७६५४३२१० call", "PHONE"],
  ["h​ttps://evil.ru/x", "INVISIBLE"],
  ["w​ww.evil.ru", "INVISIBLE"],
  ["see evil.ru slash x", "LINK"],
];

/**
 * A sixteen-digit number that is not a real card number (it is not a published test PAN and fails
 * the Luhn check), for "card-like numbers are refused" tests (CLAUDE.md invariant 7). The digit-run
 * rule refuses it without any Luhn check.
 */
export const NOT_A_CARD_NUMBER = "1234 5678 9012 3456";
