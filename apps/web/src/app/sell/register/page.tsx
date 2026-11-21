import type { Metadata } from "next";
import { RegisterFlow } from "../../_components/sell/RegisterFlow";

export const metadata: Metadata = { title: "Register your shop", robots: { index: false } };

export default function Page() {
  return <RegisterFlow />;
}
