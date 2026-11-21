import type { Metadata } from "next";
import { PinScreen } from "./PinScreen";

export const metadata: Metadata = { title: "Set your game PIN" };

export default function Page() {
  return <PinScreen />;
}
