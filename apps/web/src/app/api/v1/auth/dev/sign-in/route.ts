import { DomainError } from "@delulu/core";
import { z } from "zod";
import { type AuthProvider, authProvider } from "@/server/auth";
import { SERVER_CONFIG } from "@/server/config";
import { sessionCsrfToken } from "@/server/crypto";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { csrfCookie, sessionCookie } from "@/server/session";

/**
 * POST /api/v1/auth/dev/sign-in {email}: development only. NOT_FOUND unless AUTH_PROVIDER is 'dev'
 * (and the provider module itself refuses to load in production).
 */
export const POST = route(
  {
    auth: "anonymous",
    body: z.strictObject({ email: z.string().min(3).max(254) }),
    rateLimits: [{ rule: RATE_RULES.signInAddress }],
    preSessionCsrf: true,
  },
  async ({ body, cookieSessionId }) => {
    const { appOrigin, authProvider: kind } = env();
    if (kind !== "dev") throw new DomainError("NOT_FOUND", "Not found.");
    let provider: AuthProvider;
    try {
      provider = await authProvider();
    } catch {
      throw new DomainError("NOT_FOUND", "Not found.");
    }
    await provider.beginSignIn(body.email);
    if (cookieSessionId !== null) await provider.signOut(cookieSessionId); // replace, never stack, sessions
    const { sessionId } = await provider.completeDevSignIn(body.email);
    // the pre-session CSRF token is replaced by the one bound to the new session
    const csrfToken = sessionCsrfToken(sessionId);
    return {
      json: { signedIn: true, csrfToken },
      setCookies: [
        sessionCookie(sessionId, appOrigin, SERVER_CONFIG.session.ttlSeconds),
        csrfCookie(csrfToken, appOrigin, SERVER_CONFIG.session.ttlSeconds),
      ],
    };
  },
);
