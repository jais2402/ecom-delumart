import { publicQuiz } from "@delulu/core";
import { passportProgress } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { passportView } from "@/server/views";

/** GET /api/v1/passport: the caller's Inventor Passport progress and the quiz (questions and options, no answers). */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const progress = await passportProgress(webPool(), { authSessionId: session.id });
  return { json: { ...passportView(progress), quiz: publicQuiz() } };
});
