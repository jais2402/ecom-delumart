import type { ReactNode } from "react";
import { AccountShell } from "../_components/AccountShell";

/** Every /account page is private: a client shell that checks the session and loads data in the browser. */
export default function AccountSectionLayout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
