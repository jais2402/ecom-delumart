import type { Metadata } from "next";
import { SignInScreen } from "./SignInScreen";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Read per request: which sign-in provider is active is a runtime setting, and the page must say
 * so truthfully ("no email is sent" only when the local development provider is on).
 */
export const dynamic = "force-dynamic";

export default function Page() {
  return <SignInScreen devProvider={process.env.AUTH_PROVIDER === "dev"} />;
}
