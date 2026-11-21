import { myCompany, updateStore } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkStoreEdit } from "@/server/selling";
import { companyView } from "@/server/views";

/** GET /api/v1/company: the caller's company ({company: null} before registering). */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const company = await myCompany(webPool(), { authSessionId: session.id });
  return { json: { company: company === null ? null : companyView(company) } };
});

/**
 * PATCH /api/v1/company {displayName?, description?}: the owner edits the store (checked and
 * screened here; the handle never changes). NOT_FOUND without a company.
 */
export const PATCH = route(
  {
    auth: "session",
    body: z.strictObject({
      displayName: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
    }),
    rateLimits: [{ rule: RATE_RULES.companyActor }],
  },
  async ({ body, session }) => {
    const edit = checkStoreEdit(body);
    const company = await updateStore(webPool(), { authSessionId: session.id, ...edit });
    return { json: { company: companyView(company) } };
  },
);
