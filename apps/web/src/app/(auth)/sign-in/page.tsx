import type { Metadata } from "next";
import { SignInScreen } from "./SignInScreen";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  return <SignInScreen />;
}
