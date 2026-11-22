import "../server-only";
import { env } from "../env";
import type { AuthProvider } from "./types";

export type { AuthProvider, PhoneCodeResult, PhoneNotSentReason, PhoneSendResult } from "./types";

/**
 * The configured sign-in provider. Both are imported lazily: the dev provider throws at module
 * load in production, so it must never be a static import of a route that production builds load.
 */
export async function authProvider(): Promise<AuthProvider> {
  if (env().authProvider === "dev") {
    const { devAuthProvider } = await import("./dev");
    return devAuthProvider();
  }
  const { supabaseAuthProvider } = await import("./supabase");
  return supabaseAuthProvider();
}
