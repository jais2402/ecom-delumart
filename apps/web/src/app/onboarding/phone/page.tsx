import type { Metadata } from "next";
import { PhoneScreen } from "./PhoneScreen";

export const metadata: Metadata = { title: "Add your phone number" };

export default function Page() {
  return <PhoneScreen />;
}
