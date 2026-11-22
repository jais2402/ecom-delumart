import { useSyncExternalStore } from "react";
import { ApiError, api, type MeResponse, resetCsrf, type WalletResponse } from "./api";
import { parsePaise } from "./money";

/**
 * Who is looking at the page, loaded in the browser after the page renders (never part of the
 * static HTML). In memory only: nothing here is written to browser storage.
 */
export type SessionState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "error"; message: string }
  | {
      status: "signedIn";
      handle: string | null;
      balancePaise: bigint | null;
      onboarding: MeResponse["onboarding"];
      account: WalletResponse | null;
      /** How the phone step works right now (an owner setting); "sms" when the server does not say. */
      phoneVerification?: "sms" | "unverified";
    };

const LOADING: SessionState = { status: "loading" };
let state: SessionState = LOADING;
let started = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: SessionState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Fetches /api/v1/me and publishes the result. Safe to call repeatedly. */
export function refreshSession(): Promise<void> {
  started = true;
  inflight ??= (async () => {
    try {
      const me = await api<MeResponse>("/api/v1/me");
      set({
        status: "signedIn",
        handle: me.profile?.handle ?? null,
        balancePaise: me.account ? parsePaise(me.account.balancePaise) : null,
        onboarding: me.onboarding,
        account: me.account,
        phoneVerification: me.phoneVerification === "unverified" ? "unverified" : "sms",
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "AUTH_REQUIRED") set({ status: "signedOut" });
      else
        set({
          status: "error",
          message: error instanceof ApiError ? error.message : "Could not load your account.",
        });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function signOut(): Promise<void> {
  try {
    await api("/api/v1/auth/sign-out", { method: "POST", body: {} });
  } finally {
    resetCsrf();
    set({ status: "signedOut" });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) void refreshSession();
  return () => listeners.delete(listener);
}

export function useSession(): SessionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => LOADING,
  );
}

/** Where a person with this onboarding progress should go next, or "/account" when finished. */
export function nextOnboardingPath(
  onboarding: MeResponse["onboarding"],
  codeSent: boolean,
): "/onboarding/phone" | "/onboarding/verify" | "/onboarding/birthdate" | "/onboarding/pin" | "/account" {
  if (!(onboarding.phoneRecorded ?? onboarding.phoneVerified))
    return codeSent ? "/onboarding/verify" : "/onboarding/phone";
  if (!onboarding.hasBirthdate || !onboarding.isAdult) return "/onboarding/birthdate";
  if (!onboarding.provisioned || !onboarding.pinSet) return "/onboarding/pin";
  return "/account";
}
