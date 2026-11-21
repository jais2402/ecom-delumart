import type { Metadata } from "next";
import { DoneScreen } from "./DoneScreen";

export const metadata: Metadata = { title: "Welcome" };

export default function Page() {
  return <DoneScreen />;
}
