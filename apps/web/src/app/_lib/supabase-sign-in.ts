import { api, resetCsrf } from "./api";
import { refreshSession } from "./session-store";

/**
 * The browser side of the Supabase sign-in. The browser never sees a Supabase token: it asks the
 * server to start a flow (the server sets a sealed, HttpOnly flow cookie), and the server sets the
 * opaque session cookie when the email link, the typed code or Google completes it.
 */
const nextParam = (): string | undefined =>
  new URLSearchParams(window.location.search).get("next") ?? undefined;

export async function startEmailSignIn(email: string): Promise<void> {
  const next = nextParam();
  await api("/api/v1/auth/email/start", {
    method: "POST",
    body: next === undefined ? { email } : { email, next },
  });
}

/** The code from the sign-in email; resolves to the server-checked return path. */
export async function verifyEmailCode(email: string, code: string): Promise<string> {
  const result = await api<{ next: string }>("/api/v1/auth/email/verify", {
    method: "POST",
    body: { email, code },
  });
  resetCsrf(); // the CSRF token is now bound to the new session
  await refreshSession();
  return result.next;
}

export async function startGoogleSignIn(): Promise<void> {
  const next = nextParam();
  const { url } = await api<{ url: string }>("/api/v1/auth/google/start", {
    method: "POST",
    body: next === undefined ? {} : { next },
  });
  window.location.assign(url);
}

/** Text for the ?error= the callback sends the browser back with. */
export function callbackErrorMessage(code: string | null): string | null {
  if (code === "link") {
    return "That sign-in link did not work. It may have expired or been used already, or it was opened in a different browser. Ask for a new one below.";
  }
  if (code === "busy") return "Sign-in is busy right now. Try again in a minute.";
  return null;
}
