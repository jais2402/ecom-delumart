"use client";

import { type ReactNode, useState } from "react";
import { type ConsoleAccess, ConsoleFrame, ConsoleGate } from "../../../_components/console/ConsoleFrame";
import { PageHeading } from "../../../_components/PageHeading";
import type { QueryState } from "../_lib/use-admin-query";

/**
 * The Super Admin guard for an analytics screen, in the console's pattern: nothing but "Not
 * available" is shown to anyone the API refuses; the frame appears once any request has answered.
 */
export function AnalyticsFrame({
  current,
  title,
  states,
  children,
}: {
  current: string;
  title: string;
  states: readonly QueryState<unknown>[];
  children: ReactNode;
}) {
  const [answered, setAnswered] = useState(false);
  const denied = states.some((s) => s.status === "denied");
  const settled = states.some((s) => s.status === "ready" || s.status === "error");
  if (settled && !answered) setAnswered(true);
  const access: ConsoleAccess = denied ? "denied" : answered || settled ? "allowed" : "checking";
  if (access !== "allowed") return <ConsoleGate access={access} message="" onRetry={() => {}} />;
  return (
    <ConsoleFrame current={current}>
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeading>{title}</PageHeading>
        {children}
      </div>
    </ConsoleFrame>
  );
}
