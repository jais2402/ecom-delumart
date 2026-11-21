import { submitPassportQuiz } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { passportView } from "@/server/views";

const body = z.strictObject({
  answers: z.record(z.string().min(1).max(64), z.string().min(1).max(64)),
});

/**
 * POST /api/v1/passport/quiz {answers: {questionId: optionId}}: graded by the database against its
 * own answer key (passport_v1, migration 0050), which records only pass or fail and the rule
 * version. A failed try may be retried without limit: the response names the wrong questions,
 * never the right options.
 */
export const POST = route(
  { auth: "session", body, rateLimits: [{ rule: RATE_RULES.passportActor }] },
  async ({ body: b, session }) => {
    const graded = await submitPassportQuiz(webPool(), { authSessionId: session.id, answers: b.answers });
    return { json: { passed: graded.passed, wrong: graded.wrong, passport: passportView(graded.passport) } };
  },
);
