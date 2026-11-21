/**
 * Small in-memory scratch for the onboarding screens (never in the URL or browser storage): the
 * phone and birthdate just typed, and where to return afterwards. Where the player really is comes
 * from the server (see gateway.resolveStep); `reached` only drives the demo gateway.
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

let returnTo: string | null = null;

/** Only same-site paths: "/p/abc" is fine, "//evil.example" and "https://..." are not. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}
export const setReturnTo = (path: string | null) => {
  returnTo = safeReturnPath(path);
};
export const getReturnTo = () => returnTo;

/** Friendly text for a rejected gateway call. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Please try again.";
}
