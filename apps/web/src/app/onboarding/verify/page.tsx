import type { Metadata } from "next";
import { challengeSiteKey } from "@/server/captcha";
import { VerifyScreen } from "./VerifyScreen";

export const metadata: Metadata = { title: "Verify your phone" };

/** Read per request: whether the security check is on is a runtime setting. */
export const dynamic = "force-dynamic";

export default function Page() {
  return <VerifyScreen challengeSiteKey={challengeSiteKey()} />;
}
