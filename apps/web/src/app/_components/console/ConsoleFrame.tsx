"use client";

import { Badge, Button, ConsoleLayout, SidebarNav, Text } from "@delulu/ui";
import type { ReactNode } from "react";
import { ApiError } from "../../_lib/api";
import { isForbidden } from "../../_lib/studio";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";
import { ShopShell } from "../ShopShell";

/** True when the admin routes refused the caller (or nobody is signed in): the page says nothing about what exists. */
export function isDenied(error: unknown): boolean {
  return isForbidden(error) || (error instanceof ApiError && error.code === "AUTH_REQUIRED");
}

/** The Commerce Console frame with its navigation. */
export function ConsoleFrame({ current, children }: { current: string; children: ReactNode }) {
  return (
    <ConsoleLayout
      nav={
        <SidebarNav
          label="Commerce Console"
          currentHref={current}
          items={[
            { label: "Moderation", href: "/console/moderation" },
            { label: "Reports", href: "/console/reports" },
            { label: "Back to the shop", href: "/" },
          ]}
        />
      }
      topBar={<Badge tone="highlight">Super Admin</Badge>}
    >
      {children}
    </ConsoleLayout>
  );
}

export type ConsoleAccess = "checking" | "denied" | "allowed" | "error";

/** What a console page shows before it is allowed: loading, "Not available", or a retry. Returns null once allowed. */
export function ConsoleGate({
  access,
  message,
  onRetry,
}: {
  access: ConsoleAccess;
  message: string;
  onRetry: () => void;
}) {
  if (access === "allowed") return null;
  return (
    <ShopShell>
      {access === "checking" ? (
        <LoadingBlock rows={2} label="Loading" />
      ) : access === "denied" ? (
        <div className="flex flex-col gap-3">
          <PageHeading>Not available</PageHeading>
          <Text muted>This page is not available.</Text>
          <Button asChild className="self-start">
            <a href="/">Go to the shop</a>
          </Button>
        </div>
      ) : (
        <>
          <PageHeading>Something went wrong</PageHeading>
          <ErrorBlock message={message} onRetry={onRetry} />
        </>
      )}
    </ShopShell>
  );
}
