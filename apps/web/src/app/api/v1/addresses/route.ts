import { ADDRESS_RULES } from "@delulu/core";
import { createAddress, myAddresses } from "@delulu/db/runtime";
import { z } from "zod";
import { addressInputSchema, addressLabelSchema, addressView, sealAddress } from "@/server/address";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/addresses: the signed-in player's saved delivery addresses (PRD R5.2), decrypted on
 * the server for the owner only, default first. `private, no-store` like every session route.
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.addressReadActor }] },
  async ({ session }) => {
    const items = await myAddresses(webPool(), { authSessionId: session.id });
    return {
      json: { items: items.map((a) => addressView(a, session.actor.userId)), max: ADDRESS_RULES.maxPerUser },
    };
  },
);

const body = z.strictObject({
  label: addressLabelSchema,
  address: addressInputSchema,
  makeDefault: z.boolean().optional(),
});

/**
 * POST /api/v1/addresses {label, address, makeDefault?}: validated and screened here, encrypted
 * here; the database stores ciphertext only. ADDRESS_LIMIT beyond five.
 */
export const POST = route(
  { auth: "session", body, rateLimits: [{ rule: RATE_RULES.addressWriteActor }] },
  async ({ body: b, session }) => {
    const payloadEnc = sealAddress(b.address, session.actor.userId);
    const saved = await createAddress(webPool(), {
      authSessionId: session.id,
      label: b.label,
      payloadEnc,
      ...(b.makeDefault === undefined ? {} : { makeDefault: b.makeDefault }),
    });
    return { status: 201, json: addressView(saved, session.actor.userId) };
  },
);
