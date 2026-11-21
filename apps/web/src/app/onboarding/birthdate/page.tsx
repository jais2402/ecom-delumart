import type { Metadata } from "next";
import { BirthdateScreen } from "./BirthdateScreen";

export const metadata: Metadata = { title: "Your birthdate" };

export default function Page() {
  return <BirthdateScreen />;
}
