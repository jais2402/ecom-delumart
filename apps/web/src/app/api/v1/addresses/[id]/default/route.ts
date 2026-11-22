import { DomainError } from "@delulu/core";
import { setDefaultAddress } from "@delulu/db/runtime";
import { z } from "zod";
import { addressView } from "@/server/address";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/** POST /api/v1/addresses/{id}/default: makes one of the owner's addresses the default. */
export const POST = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.addressWriteActor }] },
  async ({ session, params }) => {
    const id = params.id ?? "";
    if (!z.uuid().safeParse(id).success) throw new DomainError("ADDRESS_NOT_FOUND", "Address not found.");
    const saved = await setDefaultAddress(webPool(), {
      authSessionId: session.id,
      addressId: id.toLowerCase(),
    });
    return { json: addressView(saved, session.actor.userId) };
  },
);
