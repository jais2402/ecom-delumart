import { gradeQuiz } from "@delulu/core";
import { recordPassportQuiz } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { passportView } from "@/server/views";

const body = z.strictObject({
  answers: z.record(z.string().min(1).max(64), z.string().min(1).max(64)),
});

/**
 * POST /api/v1/passport/quiz {answers: {questionId: optionId}}: graded here (passport_v1); the
 * database records only pass or fail and the rule version. A failed try may be retried without
 * limit: the response names the wrong questions, never the right options.
 */
export const POST = route(
  { auth: "session", body, rateLimits: [{ rule: RATE_RULES.passportActor }] },
  async ({ body: b, session }) => {
    const graded = gradeQuiz(b.answers);
    const progress = await recordPassportQuiz(webPool(), {
      authSessionId: session.id,
      passed: graded.passed,
      ruleVersion: graded.ruleVersion,
    });
    return { json: { passed: graded.passed, wrong: graded.wrong, passport: passportView(progress) } };
  },
);
