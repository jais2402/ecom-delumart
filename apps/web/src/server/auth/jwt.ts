import "../server-only";
import { webcrypto } from "node:crypto";
import type { KeySource } from "./jwks";

/**
 * Verifies a Supabase Auth access token (a JWS signed with the project's ECC P-256 key) and returns
 * the user id (`sub`) and the sign-in session id (`session_id`). Refused, with a reason that names
 * no value:
 *  - anything but a compact JWS of three canonical base64url parts, or larger than `maxBytes`;
 *  - `alg` other than exactly "ES256" (so never HS256 or none), or no `kid`;
 *  - a key id the project's JWKS does not hold (KEY), or a signature that does not verify with it;
 *  - `iss` other than `<SUPABASE_URL>/auth/v1`, `aud` without "authenticated";
 *  - `exp` missing or past, `nbf` / `iat` in the future (each with `skewSeconds` of tolerance);
 *  - `role` other than "authenticated", an anonymous user, or `sub` / `session_id` not uuids.
 */
export type TokenProblem =
  | "MALFORMED"
  | "ALG"
  | "KEY"
  | "SIGNATURE"
  | "ISSUER"
  | "AUDIENCE"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "CLAIMS";

export type VerifiedToken =
  | { ok: true; claims: { sub: string; sessionId: string; email: string | null } }
  | { ok: false; reason: TokenProblem };

export interface VerifyOptions {
  jwks: KeySource;
  issuer: string;
  audience: string;
  nowMs: number;
  skewSeconds: number;
  maxBytes: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Decodes canonical base64url only: re-encoding must give back the same text. */
function decodeSegment(segment: string): Buffer | null {
  if (!SEGMENT.test(segment)) return null;
  const bytes = Buffer.from(segment, "base64url");
  return bytes.toString("base64url") === segment ? bytes : null;
}

function parseJson(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const fail = (reason: TokenProblem): VerifiedToken => ({ ok: false, reason });

export async function verifyAccessToken(token: string, options: VerifyOptions): Promise<VerifiedToken> {
  if (typeof token !== "string" || token.length === 0 || token.length > options.maxBytes)
    return fail("MALFORMED");
  const parts = token.split(".");
  if (parts.length !== 3) return fail("MALFORMED");
  const [h = "", p = "", s = ""] = parts;
  const headerBytes = decodeSegment(h);
  const payloadBytes = decodeSegment(p);
  const header = headerBytes && parseJson(headerBytes);
  if (!header) return fail("MALFORMED");
  if (header.alg !== "ES256") return fail("ALG");
  if (typeof header.kid !== "string" || header.kid.length === 0) return fail("KEY");
  const signature = decodeSegment(s);
  const payload = payloadBytes && parseJson(payloadBytes);
  if (!payload || !signature || signature.length !== 64) return fail("MALFORMED");

  const key = await options.jwks.key(header.kid);
  if (key === null) return fail("KEY");
  const valid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new Uint8Array(signature),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return fail("SIGNATURE");

  if (payload.iss !== options.issuer) return fail("ISSUER");
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(options.audience)) return fail("AUDIENCE");
  const now = options.nowMs / 1000;
  const { exp, nbf, iat } = payload;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return fail("CLAIMS");
  if (exp + options.skewSeconds <= now) return fail("EXPIRED");
  if (nbf !== undefined && (typeof nbf !== "number" || nbf - options.skewSeconds > now))
    return fail("NOT_YET_VALID");
  if (iat !== undefined && (typeof iat !== "number" || iat - options.skewSeconds > now))
    return fail("NOT_YET_VALID");
  if (payload.role !== "authenticated" || payload.is_anonymous === true) return fail("CLAIMS");
  const { sub, session_id: sessionId, email } = payload;
  if (typeof sub !== "string" || !UUID.test(sub) || typeof sessionId !== "string" || !UUID.test(sessionId)) {
    return fail("CLAIMS");
  }
  return {
    ok: true,
    claims: {
      sub: sub.toLowerCase(),
      sessionId: sessionId.toLowerCase(),
      email: typeof email === "string" && email.length > 0 ? email : null,
    },
  };
}
