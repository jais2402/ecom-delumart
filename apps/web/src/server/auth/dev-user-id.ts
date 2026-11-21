import { createHmac } from "node:crypto";

/**
 * The dev sign-in provider's user id for an email: HMAC(IDENTITY_KEY, "dev-auth-user|<normalised
 * email>") laid out as an RFC 9562 version 8 uuid, so the same email always signs in to the same
 * user. Pure; shared by the dev provider (dev.ts) and scripts/dev-setup.ts (SUPER_ADMIN_EMAIL).
 */
export function devUserId(identityKey: Uint8Array, normalizedEmail: string): string {
  const bytes = createHmac("sha256", identityKey).update(`dev-auth-user|${normalizedEmail}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = bytes.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
