"use client";

import { Badge, Button, Heading, Text } from "@delulu/ui";
import type { CompanyView } from "../../_lib/selling";
import { useSession } from "../../_lib/session-store";
import { useApiGet } from "../../_lib/use-api";

/** Account overview: whether creator access is open, and a way to the shop or to registering one. */
export function SellingSummary() {
  const session = useSession();
  const unlocked = session.status === "signedIn" && session.account?.creatorUnlocked === true;
  const company = useApiGet<{ company: CompanyView | null }>(unlocked ? "/api/v1/company" : null);

  return (
    <section
      aria-labelledby="selling"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={2} size="md" id="selling">
          Selling
        </Heading>
        <Badge tone={unlocked ? "success" : "neutral"}>
          {unlocked ? "Creator access open" : "Creator access not open yet"}
        </Badge>
      </div>
      {!unlocked ? (
        <>
          <Text size="sm" muted>
            Two routes lead to a creator studio. See where you are on each.
          </Text>
          <Button asChild variant="secondary" className="self-start">
            <a href="/sell">Creator access</a>
          </Button>
        </>
      ) : company.status === "ready" && company.data.company ? (
        <>
          <Text>
            Your shop: <strong>{company.data.company.displayName}</strong>{" "}
            <span className="break-all font-mono text-sm text-fg-muted">
              /store/{company.data.company.handle}
            </span>
          </Text>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <a href="/sell/shop">Open your shop</a>
            </Button>
            <Button asChild variant="ghost">
              <a href={`/store/${company.data.company.handle}`}>View public page</a>
            </Button>
          </div>
        </>
      ) : company.status === "ready" ? (
        <>
          <Text size="sm" muted>
            Your creator studio is open. Register a shop to start.
          </Text>
          <Button asChild className="self-start">
            <a href="/sell/register">Register a shop</a>
          </Button>
        </>
      ) : (
        <Text size="sm" muted>
          Checking your shop…
        </Text>
      )}
    </section>
  );
}
