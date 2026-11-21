/**
 * Own profile edits through core.update_profile (migration 0023), as app_web for the caller's
 * sign-in session. The database validates every field; this layer only shapes the call.
 */
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { asWeb, one } from "./command";

export interface ProfilePrivacy {
  publicShelf: boolean;
  showCollectorLevel: boolean;
  showHandleOnPurchases: boolean;
}

export interface OwnProfile {
  userId: string;
  handle: string | null;
  privacy: ProfilePrivacy;
  researchOptOut: boolean;
}

export interface UpdateProfileInput {
  authSessionId: string;
  /** 3–24 lowercase letters, digits or hyphens; omitted or null leaves it unchanged. */
  handle?: string | null;
  /** Only the settings given change; omitted or null leaves all unchanged. */
  privacy?: Partial<ProfilePrivacy> | null;
  researchOptOut?: boolean | null;
}

const PRIVACY_KEYS: Record<keyof ProfilePrivacy, string> = {
  publicShelf: "public_shelf",
  showCollectorLevel: "show_collector_level",
  showHandleOnPurchases: "show_handle_on_purchases",
};

interface StoredProfile {
  userId: string;
  handle: string | null;
  privacy: Record<string, unknown>;
  researchOptOut: boolean;
}

export function privacyOf(stored: Record<string, unknown>): ProfilePrivacy {
  return {
    publicShelf: stored.public_shelf === true,
    showCollectorLevel: stored.show_collector_level === true,
    showHandleOnPurchases: stored.show_handle_on_purchases === true,
  };
}

export async function updateProfile(pool: Pool, input: UpdateProfileInput): Promise<OwnProfile> {
  let privacy: Record<string, boolean> | null = null;
  if (input.privacy) {
    privacy = {};
    for (const [key, value] of Object.entries(input.privacy)) {
      const column = PRIVACY_KEYS[key as keyof ProfilePrivacy];
      if (column === undefined || typeof value !== "boolean") {
        throw new DomainError("VALIDATION_FAILED", "unknown privacy setting", { key });
      }
      privacy[column] = value;
    }
  }
  const stored = await asWeb(pool, input.authSessionId, (c) =>
    one<StoredProfile>(c, "SELECT core.update_profile($1, $2::jsonb, $3) AS r", [
      input.handle ?? null,
      privacy === null ? null : JSON.stringify(privacy),
      input.researchOptOut ?? null,
    ]),
  );
  return { ...stored, privacy: privacyOf(stored.privacy) };
}
