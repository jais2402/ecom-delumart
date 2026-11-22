import "../server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/**
 * One sign-in in progress, between "send me a link" / "continue with Google" and the callback.
 * It lives ONLY in the flow cookie (HttpOnly, SameSite=Lax, __Host-, 15 minutes), sealed with
 * AES-256-GCM under a key derived from IDENTITY_KEY, so it binds the sign-in to the browser that
 * started it and nothing in it can be read or changed by that browser:
 *  - `state`: random; the callback URL must carry the same value (login CSRF);
 *  - `verifier`: the PKCE code verifier; Supabase only exchanges the code for it (RFC 7636 S256);
 *  - `returnTo`: an already-checked same-origin path (safeReturnPath);
 *  - `emailBinding`: for an email sign-in, a keyed hash of the address, so a typed code is checked
 *    only for the address this browser asked about (no address is stored in the cookie).
 */
export interface SignInFlow {
  kind: "email" | "google";
  state: string;
  verifier: string;
  returnTo: string;
  emailBinding: string | null;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export type RandomSource = (bytes: number) => Buffer;
const defaultRandom: RandomSource = (n) => randomBytes(n);

export function challengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function newPkce(random: RandomSource = defaultRandom): { verifier: string; challenge: string } {
  const verifier = random(32).toString("base64url");
  return { verifier, challenge: challengeS256(verifier) };
}

export function newState(random: RandomSource = defaultRandom): string {
  return random(32).toString("base64url");
}

/** HMAC of a NORMALISED email under the flow key (the caller normalises). */
export function emailBinding(key: Uint8Array, normalizedEmail: string): string {
  return createHmac("sha256", key).update(`email|${normalizedEmail}`, "utf8").digest("base64url");
}

const VERSION = 1;
const NONCE = 12;
const TAG = 16;

export function sealFlow(key: Uint8Array, flow: SignInFlow, random: RandomSource = defaultRandom): string {
  const nonce = random(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG });
  cipher.setAAD(Buffer.from([VERSION]));
  const body = Buffer.concat([cipher.update(JSON.stringify(flow), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]).toString("base64url");
}

const STRING_FIELDS = ["state", "verifier", "returnTo"] as const;

/** The flow, or null when the value is missing, altered, sealed with another key or expired. */
export function openFlow(key: Uint8Array, value: string | null, nowMs: number): SignInFlow | null {
  if (!value || !/^[A-Za-z0-9_-]{40,4096}$/.test(value)) return null;
  const data = Buffer.from(value, "base64url");
  if (data.length < 1 + NONCE + TAG + 2 || data[0] !== VERSION) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 1 + NONCE), {
      authTagLength: TAG,
    });
    decipher.setAAD(Buffer.from([VERSION]));
    decipher.setAuthTag(data.subarray(data.length - TAG));
    const text = Buffer.concat([
      decipher.update(data.subarray(1 + NONCE, data.length - TAG)),
      decipher.final(),
    ]);
    const parsed = JSON.parse(text.toString("utf8")) as Partial<SignInFlow>;
    if (parsed.kind !== "email" && parsed.kind !== "google") return null;
    for (const field of STRING_FIELDS) if (typeof parsed[field] !== "string") return null;
    if (parsed.emailBinding !== null && typeof parsed.emailBinding !== "string") return null;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= nowMs) return null;
    return parsed as SignInFlow;
  } catch {
    return null;
  }
}
