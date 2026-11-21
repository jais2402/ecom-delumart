import "./server-only";
import {
  checkListingFields,
  checkPriceRupees,
  checkQuantity,
  DomainError,
  type ListingProblem,
  rupeesToPaise,
} from "@delulu/core";
import type { DraftChanges, DraftInput, RevisionInput } from "@delulu/db/runtime";
import { z } from "zod";

/**
 * The studio's request shapes. The server checks shapes and lengths only (and the database checks
 * them again); listing text is NOT screened here: the screening job screens every submitted
 * revision. A refusal is VALIDATION_FAILED with `details.reasons` [{field, code}] (no text echoed).
 */

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(40);
const text = (max: number) => z.string().max(max);
const whole = z.number().int();

export const draftBody = z.strictObject({
  name: text(400),
  hook: text(700).nullable().optional(),
  description: text(5000),
  category: slug,
  templateId: whole,
  altText: text(1500).optional(),
  priceRupees: whole,
  inventoryMode: z.enum(["STANDARD_STOCKED", "EXCLUSIVE"]),
  quantity: whole,
  offersExpress: z.boolean().optional(),
  freeStandardDelivery: z.boolean().optional(),
});

export const draftPatchBody = draftBody.partial();

export const revisionBody = z.strictObject({
  name: text(400).optional(),
  hook: text(700).nullable().optional(),
  description: text(5000).optional(),
  altText: text(1500).optional(),
  templateId: whole.optional(),
});

interface Reason {
  field: string;
  code: string;
}

function refuse(reasons: readonly Reason[]): never {
  throw new DomainError("VALIDATION_FAILED", "Some fields need changes.", { reasons: [...reasons] });
}

function checks(
  fields: Parameters<typeof checkListingFields>[0],
  required: boolean,
  extra: { priceRupees?: number | undefined; quantity?: number | undefined },
): void {
  const reasons: Reason[] = checkListingFields(fields, { required }).map((p: ListingProblem) => ({
    field: p.field,
    code: p.code,
  }));
  if (extra.priceRupees !== undefined && !checkPriceRupees(extra.priceRupees)) {
    reasons.push({ field: "priceRupees", code: "OUT_OF_RANGE" });
  }
  if (extra.quantity !== undefined && !checkQuantity(extra.quantity)) {
    reasons.push({ field: "quantity", code: "OUT_OF_RANGE" });
  }
  if (reasons.length > 0) refuse(reasons);
}

const fieldsOf = (b: {
  name?: string | undefined;
  hook?: string | null | undefined;
  description?: string | undefined;
  altText?: string | undefined;
  templateId?: number | undefined;
}) => ({
  name: b.name,
  hook: b.hook,
  description: b.description,
  altText: b.altText,
  templateId: b.templateId,
});

export function checkDraft(b: z.infer<typeof draftBody>): DraftInput {
  checks(fieldsOf(b), true, { priceRupees: b.priceRupees, quantity: b.quantity });
  return {
    name: b.name,
    hook: b.hook ?? null,
    description: b.description,
    category: b.category,
    templateId: b.templateId,
    altText: b.altText ?? "",
    pricePaise: rupeesToPaise(b.priceRupees),
    inventoryMode: b.inventoryMode,
    quantity: b.quantity,
    offersExpress: b.offersExpress ?? false,
    freeStandardDelivery: b.freeStandardDelivery ?? false,
  };
}

export function checkDraftChanges(b: z.infer<typeof draftPatchBody>): DraftChanges {
  checks(fieldsOf(b), false, { priceRupees: b.priceRupees, quantity: b.quantity });
  const out: DraftChanges = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.hook !== undefined) out.hook = b.hook;
  if (b.description !== undefined) out.description = b.description;
  if (b.category !== undefined) out.category = b.category;
  if (b.templateId !== undefined) out.templateId = b.templateId;
  if (b.altText !== undefined) out.altText = b.altText;
  if (b.priceRupees !== undefined) out.pricePaise = rupeesToPaise(b.priceRupees);
  if (b.inventoryMode !== undefined) out.inventoryMode = b.inventoryMode;
  if (b.quantity !== undefined) out.quantity = b.quantity;
  if (b.offersExpress !== undefined) out.offersExpress = b.offersExpress;
  if (b.freeStandardDelivery !== undefined) out.freeStandardDelivery = b.freeStandardDelivery;
  return out;
}

export function checkRevision(b: z.infer<typeof revisionBody>): RevisionInput {
  checks(fieldsOf(b), false, {});
  const out: RevisionInput = {};
  if (b.name !== undefined) out.name = b.name;
  if (b.hook !== undefined) out.hook = b.hook;
  if (b.description !== undefined) out.description = b.description;
  if (b.altText !== undefined) out.altText = b.altText;
  if (b.templateId !== undefined) out.templateId = b.templateId;
  return out;
}

export function checkPrice(priceRupees: number): bigint {
  if (!checkPriceRupees(priceRupees)) refuse([{ field: "priceRupees", code: "OUT_OF_RANGE" }]);
  return rupeesToPaise(priceRupees);
}

export function checkStockQuantity(quantity: number | undefined, required: boolean): number | undefined {
  if (quantity === undefined) {
    if (required) refuse([{ field: "quantity", code: "REQUIRED" }]);
    return undefined;
  }
  if (!checkQuantity(quantity)) refuse([{ field: "quantity", code: "OUT_OF_RANGE" }]);
  return quantity;
}

/** A path id for an admin route: anything malformed becomes the nil id, so the database answers
 * (FORBIDDEN for a non-admin, NOT_FOUND for the Super Admin) exactly as for a missing target. */
export function adminTargetId(value: string | undefined): string {
  if (value !== undefined && z.uuid().safeParse(value).success) return value.toLowerCase();
  return "00000000-0000-0000-0000-000000000000";
}
