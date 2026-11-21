import { authProvider } from "@/server/auth";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { clearedSessionCookie } from "@/server/session";

/** POST /api/v1/auth/sign-out: deletes the sign-in session row and the cookie. */
export const POST = route({ auth: "anonymous" }, async ({ cookieSessionId }) => {
  if (cookieSessionId !== null) await (await authProvider()).signOut(cookieSessionId);
  return { json: { signedOut: true }, setCookies: [clearedSessionCookie(env().appOrigin)] };
});
