import { randomBytes } from "node:crypto";
import { SERVER_CONFIG } from "@/server/config";
import { sessionCsrfToken } from "@/server/crypto";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { cookieNames, csrfCookie, readCookie, readSessionId } from "@/server/session";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * GET /api/v1/auth/csrf: the double-submit token (cookie + body). With a session cookie it is the
 * token bound to that session, HMAC(server key, session id); without one, a pre-session random
 * token (kept while it is well formed), which only the sign-in route accepts for a signed-in call.
 */
export const GET = route({ auth: "anonymous" }, async ({ request }) => {
  const { appOrigin } = env();
  const sessionId = readSessionId(request, appOrigin);
  const existing = readCookie(request, cookieNames(appOrigin).csrf);
  const token =
    sessionId !== null
      ? sessionCsrfToken(sessionId)
      : existing && TOKEN.test(existing)
        ? existing
        : randomBytes(SERVER_CONFIG.csrf.tokenBytes).toString("base64url");
  return {
    json: { csrfToken: token },
    setCookies: [csrfCookie(token, appOrigin, SERVER_CONFIG.session.ttlSeconds)],
  };
});
