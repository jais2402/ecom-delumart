import { DomainError, type ScreenReason, screenText } from "@delulu/core";
import { updateProfile } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";

const body = z.strictObject({
  handle: z
    .string()
    .regex(/^[a-z0-9-]{3,24}$/)
    .optional(),
  privacy: z
    .strictObject({
      publicShelf: z.boolean().optional(),
      showCollectorLevel: z.boolean().optional(),
      showHandleOnPurchases: z.boolean().optional(),
    })
    .optional(),
  researchOptOut: z.boolean().optional(),
});

/**
 * POST /api/v1/profile {handle?, privacy?, researchOptOut?}: changes the caller's own handle,
 * privacy switches and research opt-out through core.update_profile, which validates every field
 * (a taken or reserved handle is CONFLICT). Only the fields given change, so an empty body returns
 * the current profile. The response names exactly these fields and nothing else.
 *
 * A handle is public text (seventh review, 5a): it is screened here with screenText and refused
 * (VALIDATION_FAILED with reasons) unless OK; the database refuses reserved and look-alike handles
 * (CONFLICT) and keeps the strict charset.
 */
export const POST = route({ auth: "session", body }, async ({ body: b, session }) => {
  if (b.handle !== undefined) {
    const screened = screenText({ handle: b.handle });
    if (screened.verdict !== "OK") {
      throw new DomainError("VALIDATION_FAILED", "Some fields need changes.", {
        reasons: screened.reasons.map((r: ScreenReason) => ({ field: r.field, code: r.code })),
      });
    }
  }
  const profile = await updateProfile(webPool(), {
    authSessionId: session.id,
    ...(b.handle === undefined ? {} : { handle: b.handle }),
    ...(b.privacy === undefined ? {} : { privacy: b.privacy }),
    ...(b.researchOptOut === undefined ? {} : { researchOptOut: b.researchOptOut }),
  });
  return {
    json: {
      handle: profile.handle,
      privacy: {
        publicShelf: profile.privacy.publicShelf,
        showCollectorLevel: profile.privacy.showCollectorLevel,
        showHandleOnPurchases: profile.privacy.showHandleOnPurchases,
      },
      researchOptOut: profile.researchOptOut,
    },
  };
});
