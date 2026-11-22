import "./server-only";
import {
  ADDRESS_LABELS,
  ADDRESS_RULES,
  type Address,
  type AddressInput,
  addressFromJson,
  addressToJson,
  DomainError,
  formatAddress,
  type ScreenCode,
  screenText,
  validateAddress,
} from "@delulu/core";
import type { OrderDelivery, StoredAddress } from "@delulu/db/runtime";
import { z } from "zod";
import { FICTIONAL_LOCALITIES } from "../data/delivery-spots";
import { decryptField, encryptField, type FieldBinding } from "./crypto";

/**
 * Delivery addresses on the web server (PRD R5.2). The address is validated (@delulu/core), screened
 * for abuse only, and encrypted HERE with FIELD_KEY (AES-256-GCM, LLD §5.6) bound to
 * ("address", user id); only the ciphertext reaches the database, and only the owner's own requests
 * decrypt it. Nothing in this module logs.
 */

/** The binding of an encrypted address (and of every order copy of it). */
export const addressBinding = (userId: string): FieldBinding => ({ table: "address", userId });

/** Generous caps at the edge; @delulu/core applies the exact rules. */
const text = (max: number) => z.string().max(max);
export const addressInputSchema = z.strictObject({
  recipientName: text(ADDRESS_RULES.nameMaxChars * 2),
  line1: text(ADDRESS_RULES.lineMaxChars * 2),
  line2: text(ADDRESS_RULES.lineMaxChars * 2)
    .nullable()
    .optional(),
  city: text(ADDRESS_RULES.cityMaxChars * 2),
  state: text(8),
  postalCode: text(12),
  country: z.literal("IN").default("IN"),
});
export const addressLabelSchema = z.enum(ADDRESS_LABELS);

/**
 * Abuse screening only (an ordinary address is never refused): links, email addresses, blocked
 * terms, and phone-number-like runs (decisions.md #5: no phone on an address; this also keeps card
 * numbers out, invariant 7). Review-level signals (capitals, official-sounding words) are ignored.
 */
const ADDRESS_REJECT: ReadonlySet<ScreenCode> = new Set(["LINK", "EMAIL", "PHONE", "BLOCKED_TERM"]);

export function screenAddress(a: Address): void {
  const result = screenText({
    recipientName: a.recipientName,
    line1: a.line1,
    line2: a.line2 ?? "",
    city: a.city,
  });
  const reasons = result.reasons.filter((r) => ADDRESS_REJECT.has(r.code));
  if (reasons.length > 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Remove links, email addresses or phone numbers from the address.",
      {
        field: reasons[0]?.field ?? "line1",
        reasons,
      },
    );
  }
}

/** Validated, screened and encrypted: what the database receives. */
export function sealAddress(input: AddressInput, userId: string): Buffer {
  const address = validateAddress(input);
  screenAddress(address);
  return encryptField(addressToJson(address), addressBinding(userId));
}

export function openAddress(payloadEnc: Uint8Array, userId: string): Address {
  return addressFromJson(decryptField(payloadEnc, addressBinding(userId)));
}

const LABEL_NAMES: Record<(typeof ADDRESS_LABELS)[number], string> = {
  HOME: "Home",
  WORK: "Work",
  OTHER: "Other",
};

export function addressView(a: StoredAddress, userId: string) {
  const address = openAddress(a.payloadEnc, userId);
  return {
    id: a.id,
    label: a.label,
    labelName: LABEL_NAMES[a.label],
    isDefault: a.isDefault,
    address,
    text: formatAddress(address),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** A stable fictional spot name for an order (presentation only; no personal data). */
export function fictionalSpotFor(orderId: string): string {
  let h = 0;
  for (const ch of orderId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FICTIONAL_LOCALITIES[h % FICTIONAL_LOCALITIES.length]?.name ?? "Cloud Nine Heights";
}

/** The buyer's own view of an order's destination (decrypted for the owner only). */
export function orderDeliveryView(d: OrderDelivery, orderId: string, userId: string) {
  if (d.kind === "ADDRESS") {
    const address = openAddress(d.payloadEnc, userId);
    return {
      kind: "ADDRESS" as const,
      label: d.label,
      labelName: LABEL_NAMES[d.label],
      text: formatAddress(address),
    };
  }
  if (d.kind === "ADDRESS_REMOVED") return { kind: "ADDRESS_REMOVED" as const };
  return { kind: "FICTIONAL_SPOT" as const, text: fictionalSpotFor(orderId) };
}
