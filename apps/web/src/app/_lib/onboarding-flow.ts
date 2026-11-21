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

/** Where a person lands after signing in when no safe return path was given. */
export const DEFAULT_RETURN_PATH = "/account";
/** Longer return paths are refused rather than trimmed. */
const MAX_RETURN_PATH = 2048;

/** A C0/C1 control character (the URL parser silently drops tab, CR and LF) or a backslash. */
function hasUnsafeCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x5c) return true;
  }
  return false;
}

/**
 * The one check for a return path read from anywhere (the `next` query parameter, the scratch):
 * no control character or backslash, raw or percent-encoded; it must resolve against `origin` to
 * that same origin; and the answer is only its path, query and fragment, beginning with a single
 * "/". Anything else is DEFAULT_RETURN_PATH.
 */
export function safeReturnPath(value: string | null | undefined, origin: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RETURN_PATH) {
    return DEFAULT_RETURN_PATH;
  }
  if (!value.startsWith("/") || value.startsWith("//") || hasUnsafeCharacter(value))
    return DEFAULT_RETURN_PATH;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return DEFAULT_RETURN_PATH;
  }
  if (decoded.startsWith("//") || hasUnsafeCharacter(decoded)) return DEFAULT_RETURN_PATH;
  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(value, base);
  } catch {
    return DEFAULT_RETURN_PATH;
  }
  if (url.origin !== base.origin) return DEFAULT_RETURN_PATH;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/") || path.startsWith("//") || hasUnsafeCharacter(path)) return DEFAULT_RETURN_PATH;
  return path;
}

export const setReturnTo = (path: string | null, origin: string) => {
  returnTo = path === null ? null : safeReturnPath(path, origin);
};
export const getReturnTo = () => returnTo;

/** Friendly text for a rejected gateway call. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Please try again.";
}
