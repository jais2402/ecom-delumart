import "../server-only";

/**
 * The sign-in service seam (LLD §7.1). The web server never trusts the browser about who is signed
 * in: the provider creates sign-in sessions (auth.sessions rows), confirms email and phone, and the
 * database derives the acting user from the session id on every call.
 */
export interface AuthProvider {
  readonly kind: "dev" | "supabase";
  /** Starts a sign-in for the email (the dev provider signs in at once; Supabase sends a link). */
  beginSignIn(email: string): Promise<{ next: "complete-dev-sign-in" | "check-email" }>;
  /** Dev only: creates or reuses the user for the normalised email and a new live session. */
  completeDevSignIn(email: string): Promise<{ sessionId: string; userId: string }>;
  /** Ends the session (deletes its auth.sessions row). */
  signOut(sessionId: string): Promise<void>;
  /** The verified email of the session's user, or null when the provider no longer knows it. */
  verifiedEmail(sessionId: string): Promise<string | null>;
  /**
   * Sends a verification code to the E.164 number; `devCode` is set by the dev provider only. When
   * no code could be sent the answer says so with an internal reason (never shown to the person:
   * the route answers one neutral message for every reason, ninth review major 1a).
   */
  sendPhoneCode(sessionId: string, e164: string): Promise<PhoneSendResult>;
  /** Checks the code; on success the confirmed E.164 number. */
  verifyPhoneCode(sessionId: string, code: string): Promise<PhoneCodeResult>;
}

export type PhoneSendResult =
  | { sent: true; devCode: string | null }
  | { sent: false; reason: PhoneNotSentReason };

/**
 * Why no code went out. NUMBER_HELD: the sign-in service keeps the number on another user that
 * could not be released (confirmed, or held for less than the code lifetime); NOT_SET: the number
 * could not be set for another reason; PROVIDER_LIMIT / NOT_SENT: the SMS provider refused.
 */
export type PhoneNotSentReason = "NUMBER_HELD" | "NOT_SET" | "PROVIDER_LIMIT" | "NOT_SENT";

export type PhoneCodeResult =
  | { ok: true; e164: string }
  | { ok: false; reason: "NO_CODE_REQUESTED" | "WRONG_CODE" | "TOO_MANY_TRIES" };
