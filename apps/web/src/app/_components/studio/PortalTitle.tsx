"use client";

import { FictionLabel } from "@delulu/ui";
import type { ReactNode } from "react";
import { PageHeading } from "../PageHeading";

/** The portal page's h1 with the one fiction reminder for the page, and optional actions beside it. */
export function PortalTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-1">
        <PageHeading>{children}</PageHeading>
        <FictionLabel>All amounts are fictional</FictionLabel>
      </div>
      {actions}
    </div>
  );
}
