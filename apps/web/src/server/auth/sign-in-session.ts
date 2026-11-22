import "../server-only";
import { DomainError } from "@delulu/core";
import { endSession } from "@delulu/db/runtime";
import { safeReturnPath } from "../../app/_lib/onboarding-flow";
import { SERVER_CONFIG } from "../config";
import { sessionCsrfToken } from "../crypto";
import { webPool } from "../db";
import { env } from "../env";
import {
  clearedFlowCookie,
  cookieNames,
  csrfCookie,
  readCookie,
  readSessionId,
  sessionCookie,
} from "../session";
import { emailBinding, newPkce, newState, openFlow, type SignInFlow, sealFlow } from "./flow";
import { flowEmailKey, flowKey } from "./supabase";

/**
 * The pieces every Supabase sign-in route shares: starting a flow (state, PKCE, return path, the
 * sealed cookie), reading it back, and turning an accepted sign-in session into the cookies.
 */
export function requireSupabase(): void {
  if (env().authProvider !== "supabase" || env().supabase === null)
    throw new DomainError("NOT_FOUND", "Not found.");
}

export function startFlow(
  kind: SignInFlow["kind"],
  next: string | undefined,
  normalizedEmail: string | null,
): { flow: SignInFlow; challenge: string; sealed: string } {
  const { appOrigin } = env();
  const { verifier, challenge } = newPkce();
  const flow: SignInFlow = {
    kind,
    state: newState(),
    verifier,
    returnTo: safeReturnPath(next ?? null, appOrigin),
    emailBinding: normalizedEmail === null ? null : emailBinding(flowEmailKey(), normalizedEmail),
    expiresAt: Date.now() + SERVER_CONFIG.auth.flowTtlSeconds * 1000,
  };
  return { flow, challenge, sealed: sealFlow(flowKey(), flow) };
}

export function readFlow(request: Request): SignInFlow | null {
  const { appOrigin } = env();
  return openFlow(flowKey(), readCookie(request, cookieNames(appOrigin).flow), Date.now());
}

/** True when the flow was started in this browser for exactly this (normalised) address. */
export function flowIsFor(flow: SignInFlow, normalizedEmail: string): boolean {
  return flow.kind === "email" && flow.emailBinding === emailBinding(flowEmailKey(), normalizedEmail);
}

/**
 * The cookies of a new sign-in: the session (its auth.sessions id), the CSRF token bound to it,
 * and the flow cleared. A different session the browser still held is ended first: session ids
 * rotate at sign-in, they never stack.
 */
export async function signedInCookies(
  request: Request,
  sessionId: string,
): Promise<{ csrfToken: string; cookies: string[] }> {
  const { appOrigin } = env();
  const previous = readSessionId(request, appOrigin);
  if (previous !== null && previous !== sessionId) {
    await endSession(webPool(), { authSessionId: previous }).catch(() => undefined);
  }
  const csrfToken = sessionCsrfToken(sessionId);
  return {
    csrfToken,
    cookies: [
      sessionCookie(sessionId, appOrigin, SERVER_CONFIG.session.ttlSeconds),
      csrfCookie(csrfToken, appOrigin, SERVER_CONFIG.session.ttlSeconds),
      clearedFlowCookie(appOrigin),
    ],
  };
}
