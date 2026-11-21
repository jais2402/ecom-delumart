import { randomBytes } from "node:crypto";
import { SERVER_CONFIG } from "@/server/config";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { cookieNames, csrfCookie, readCookie } from "@/server/session";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** GET /api/v1/auth/csrf: the double-submit token (cookie + body); an existing token is kept. */
export const GET = route({ auth: "anonymous" }, async ({ request }) => {
  const { appOrigin } = env();
  const existing = readCookie(request, cookieNames(appOrigin).csrf);
  const token =
    existing && TOKEN.test(existing)
      ? existing
      : randomBytes(SERVER_CONFIG.csrf.tokenBytes).toString("base64url");
  return {
    json: { csrfToken: token },
    setCookies: [csrfCookie(token, appOrigin, SERVER_CONFIG.session.ttlSeconds)],
  };
});
