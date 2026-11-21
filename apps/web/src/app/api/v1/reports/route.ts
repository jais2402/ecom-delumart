import { createReport, myReports } from "@delulu/db/runtime";
import { payPool, webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkReport, reportBody } from "@/server/safety";
import { myReportView, reportReceiptView } from "@/server/views";

/** GET /api/v1/reports: the caller's own reports (reference, target, reason, case status), newest first. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const items = await myReports(webPool(), { authSessionId: session.id });
  return { json: { items: items.map(myReportView) } };
});

/**
 * POST /api/v1/reports {targetType, targetId, reason, detail?}: reports a published product or a
 * store; returns the case reference. REPORT_LIMIT beyond five per hour (counted here and on the
 * committed reports in the database), ALREADY_REPORTED while the caller's report on it is open.
 * Three independent reports hide a product at once, pending review.
 */
export const POST = route(
  { auth: "session", body: reportBody, rateLimits: [{ rule: RATE_RULES.reportActor }] },
  async ({ body, session }) => {
    const { detail, detailFlags } = checkReport(body);
    // the pay credential only: the detail and its flags are this server's screening (0050)
    const receipt = await createReport(payPool(), {
      authSessionId: session.id,
      targetType: body.targetType,
      targetId: body.targetId.toLowerCase(),
      reason: body.reason,
      detail,
      detailFlags,
    });
    return { status: 201, json: reportReceiptView(receipt) };
  },
);
