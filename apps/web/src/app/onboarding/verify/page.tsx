import type { Metadata } from "next";
import { VerifyScreen } from "./VerifyScreen";

export const metadata: Metadata = { title: "Verify your phone" };

export default function Page() {
  return <VerifyScreen />;
}
