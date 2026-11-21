/**
 * Where the player is in onboarding, kept in memory only (never in the URL or browser storage).
 * A full page reload resets it and sends the player back to the first missing step.
 * When the backend is wired this should be derived from the session instead.
 */
export const FLOW_PATHS = [
  "/sign-in",
  "/onboarding/phone",
  "/onboarding/verify",
  "/onboarding/birthdate",
  "/onboarding/pin",
  "/onboarding/done",
] as const;

export type FlowStep = 0 | 1 | 2 | 3 | 4 | 5;

type FlowState = { reached: FlowStep; phone: string | null; birthdate: string | null };

const state: FlowState = { reached: 0, phone: null, birthdate: null };

export const getReached = (): FlowStep => state.reached;

/** Move forward only. */
export function advanceTo(step: FlowStep): void {
  if (step > state.reached) state.reached = step;
}

export const getPhone = () => state.phone;
export const setPhone = (e164: string) => {
  state.phone = e164;
};
export const getBirthdate = () => state.birthdate;
export const setBirthdate = (iso: string) => {
  state.birthdate = iso;
};

/** Friendly text for a rejected gateway call. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Please try again.";
}
