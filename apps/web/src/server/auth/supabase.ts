import "../server-only";
import type { AuthProvider } from "./types";

/**
 * NOT IMPLEMENTED. Every method throws, so AUTH_PROVIDER=supabase signs nobody in.
 *
 * What the real provider must do (and nothing here may be written without tests against a real
 * Supabase project's keys):
 * - Sign-in: Supabase Auth email link or Google. The browser still holds only the opaque
 *   session cookie; the access token never becomes a bearer the web server trusts unverified.
 * - On each request, verify the ES256 access token's signature against the project's JWKS
 *   (`/auth/v1/.well-known/jwks.json`, cached by `kid`, refreshed on unknown kid), check `iss`,
 *   `aud`, `exp` / `nbf` with small skew, and read the `session_id` claim. Never trust an
 *   unverified or expired token, an `alg` other than ES256, or a token from another project.
 * - Pass that session id to the database, which re-checks auth.sessions (live, user not banned or
 *   deleted) on every call (core.actor_id()).
 * - Phone: send and verify the SMS code through Supabase Auth so that auth.users.phone_confirmed_at
 *   is set (migration 0024 then requires it), with the LLD §11.2 SMS limits.
 * - Sign-out: revoke the session through the Supabase Admin API (scope "local").
 */
function notImplemented(): never {
  throw new Error("The Supabase sign-in provider is not implemented yet.");
}

export function supabaseAuthProvider(): AuthProvider {
  return {
    kind: "supabase",
    beginSignIn: async () => notImplemented(),
    completeDevSignIn: async () => notImplemented(),
    signOut: async () => notImplemented(),
    verifiedEmail: async () => notImplemented(),
    sendPhoneCode: async () => notImplemented(),
    verifyPhoneCode: async () => notImplemented(),
  };
}
