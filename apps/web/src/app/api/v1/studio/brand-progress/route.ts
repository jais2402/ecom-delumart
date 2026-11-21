import { myBrandProgress } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { brandProgressView } from "@/server/views";

/** GET /api/v1/studio/brand-progress: qualifying gross and eligible buyers against the brand thresholds (read only). */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const progress = await myBrandProgress(webPool(), { authSessionId: session.id });
  return { json: brandProgressView(progress) };
});
