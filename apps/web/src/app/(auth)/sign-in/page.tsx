import type { Metadata } from "next";
import { challengeSiteKey } from "@/server/captcha";
import { env } from "@/server/env";
import { SignInScreen } from "./SignInScreen";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Read per request: which sign-in provider is active is a runtime setting, and the page must say
 * so truthfully ("no email is sent" only when the local development provider is on).
 */
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  return (
    <SignInScreen
      devProvider={process.env.AUTH_PROVIDER === "dev"}
      callbackError={error}
      challengeSiteKey={challengeSiteKey()}
      googleEnabled={env().googleSignIn}
    />
  );
}
