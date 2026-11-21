import "./server-only";
import {
  DomainError,
  PASSPORT_V1,
  type ScreenReason,
  STORE_DESCRIPTION_MAX_CHARS,
  screenText,
  validateHandle,
  validateStoreName,
} from "@delulu/core";

/**
 * Text checks of the selling side that the web server makes before the database is called (the
 * database takes the screening verdict on this server's word, and checks formats, lengths, the
 * reserved list and uniqueness itself). A refusal is VALIDATION_FAILED with `details.reasons`:
 * [{field, code}] per input field; no submitted text is echoed.
 */

export interface FieldReason {
  field: string;
  code: string;
}

function refuse(reasons: readonly FieldReason[]): never {
  throw new DomainError("VALIDATION_FAILED", "Some fields need changes.", { reasons: [...reasons] });
}

/** Screening must be OK for every field; anything else (REJECT or NEEDS_REVIEW) is refused. */
function requireScreenedOk(fields: Record<string, string>): void {
  const result = screenText(fields);
  if (result.verdict !== "OK")
    refuse(result.reasons.map((r: ScreenReason) => ({ field: r.field, code: r.code })));
}

/** The passport concept, trimmed: 20–280 characters (passport_v1) and screened OK. */
export function checkConcept(concept: string): string {
  const value = concept.trim();
  const n = [...value].length;
  if (n < PASSPORT_V1.concept.minChars) refuse([{ field: "concept", code: "TOO_SHORT" }]);
  if (n > PASSPORT_V1.concept.maxChars) refuse([{ field: "concept", code: "TOO_LONG" }]);
  requireScreenedOk({ concept: value });
  return value;
}

function checkDescription(description: string, reasons: FieldReason[]): string {
  const value = description.trim();
  if ([...value].length > STORE_DESCRIPTION_MAX_CHARS)
    reasons.push({ field: "description", code: "TOO_LONG" });
  // control characters other than a line break
  const control = [...value].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (c < 0x20 && c !== 0x0a) || c === 0x7f;
  });
  if (control) reasons.push({ field: "description", code: "CONTROL_CHARACTERS" });
  return value;
}

/** A registration's identity: handle (lower-cased), display name and description, each checked and screened OK. */
export function checkStoreIdentity(input: { handle: string; displayName: string; description: string }) {
  const reasons: FieldReason[] = [];
  const handle = validateHandle(input.handle.trim().toLowerCase());
  if (!handle.ok) reasons.push({ field: "handle", code: handle.code });
  const name = validateStoreName(input.displayName);
  if (!name.ok) reasons.push({ field: "displayName", code: name.code });
  const description = checkDescription(input.description, reasons);
  if (reasons.length > 0) refuse(reasons);
  if (!handle.ok || !name.ok) throw new Error("unreachable");
  requireScreenedOk({ handle: handle.value, displayName: name.value, description });
  return { handle: handle.value, displayName: name.value, description };
}

/** A store edit: the fields given, each checked and screened OK. */
export function checkStoreEdit(input: {
  displayName?: string | undefined;
  description?: string | undefined;
}) {
  const reasons: FieldReason[] = [];
  const out: { displayName?: string; description?: string } = {};
  if (input.displayName !== undefined) {
    const name = validateStoreName(input.displayName);
    if (name.ok) out.displayName = name.value;
    else reasons.push({ field: "displayName", code: name.code });
  }
  if (input.description !== undefined) out.description = checkDescription(input.description, reasons);
  if (reasons.length > 0) refuse(reasons);
  const screen: Record<string, string> = {};
  if (out.displayName !== undefined) screen.displayName = out.displayName;
  if (out.description !== undefined) screen.description = out.description;
  requireScreenedOk(screen);
  return out;
}
