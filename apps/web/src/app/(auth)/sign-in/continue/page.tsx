import type { Metadata } from "next";
import { ContinueScreen } from "./ContinueScreen";

export const metadata: Metadata = { title: "Signing you in" };

export const dynamic = "force-dynamic";

/** Where the sign-in callback sends the browser once its session cookie is set. */
export default function Page() {
  return <ContinueScreen />;
}
