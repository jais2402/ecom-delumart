import { DomainError } from "@delulu/core";
import { deleteAddress, updateAddress } from "@delulu/db/runtime";
import { z } from "zod";
import { addressInputSchema, addressLabelSchema, addressView, sealAddress } from "@/server/address";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

const UUID = z.uuid();

/** A path id that is not a uuid is answered like someone else's: ADDRESS_NOT_FOUND. */
function addressId(params: Readonly<Record<string, string>>): string {
  const id = params.id ?? "";
  if (!UUID.safeParse(id).success) throw new DomainError("ADDRESS_NOT_FOUND", "Address not found.");
  return id.toLowerCase();
}

const body = z
  .strictObject({ label: addressLabelSchema.optional(), address: addressInputSchema.optional() })
  .refine((b) => b.label !== undefined || b.address !== undefined);

/**
 * PATCH /api/v1/addresses/{id} {label?, address?}: the owner's own address only (anyone else's is
 * ADDRESS_NOT_FOUND). Orders already placed keep the address as it was.
 */
export const PATCH = route(
  { auth: "session", body, rateLimits: [{ rule: RATE_RULES.addressWriteActor }] },
  async ({ body: b, session, params }) => {
    const saved = await updateAddress(webPool(), {
      authSessionId: session.id,
      addressId: addressId(params),
      ...(b.label === undefined ? {} : { label: b.label }),
      ...(b.address === undefined ? {} : { payloadEnc: sealAddress(b.address, session.actor.userId) }),
    });
    return { json: addressView(saved, session.actor.userId) };
  },
);

/**
 * DELETE /api/v1/addresses/{id}: deleted for real (PRD R5.2); past orders that used it show
 * "Address removed". The most recent remaining address becomes the default if this one was.
 */
export const DELETE = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.addressWriteActor }] },
  async ({ session, params }) => {
    const r = await deleteAddress(webPool(), { authSessionId: session.id, addressId: addressId(params) });
    return { json: r };
  },
);
