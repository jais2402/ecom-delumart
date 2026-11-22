import type { Metadata } from "next";
import { challengeSiteKey } from "@/server/captcha";
import { PhoneScreen } from "./PhoneScreen";

export const metadata: Metadata = { title: "Add your phone number" };

/** Read per request: whether the security check is on is a runtime setting. */
export const dynamic = "force-dynamic";

export default function Page() {
  return <PhoneScreen challengeSiteKey={challengeSiteKey()} />;
}
