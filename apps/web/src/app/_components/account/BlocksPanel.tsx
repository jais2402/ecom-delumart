"use client";

import { Alert, Button, EmptyState, Text } from "@delulu/ui";
import { useState } from "react";
import { api } from "../../_lib/api";
import { markBlocked } from "../../_lib/blocks-store";
import { type BlockRow, merchantErrorText } from "../../_lib/merchant";
import { formatWhen } from "../../_lib/orders";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";
import { BLOCK_EXPLANATION } from "../safety/BlockShop";

/** /account/blocks: the shops the person blocked, each with an Unblock button. */
export function BlocksPanel() {
  const loaded = useApiGet<{ items: BlockRow[] }>("/api/v1/blocks");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function unblock(row: BlockRow) {
    setBusy(row.companyId);
    setMessage(null);
    try {
      await api("/api/v1/blocks", { method: "DELETE", body: { companyId: row.companyId } });
      markBlocked(row.companyId, false);
      setMessage({ tone: "success", text: `You unblocked ${row.displayName}.` });
      loaded.reload();
    } catch (e) {
      setMessage({ tone: "danger", text: merchantErrorText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>Blocked shops</PageHeading>
      <Text muted>{BLOCK_EXPLANATION}</Text>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {loaded.status === "loading" ? <LoadingBlock rows={2} label="Loading blocked shops" /> : null}
      {loaded.status === "error" ? <ErrorBlock message={loaded.message} onRetry={loaded.reload} /> : null}
      {loaded.status === "ready" && loaded.data.items.length === 0 ? (
        <EmptyState
          title="You have not blocked any shops"
          description="Block a shop from its page, or from the menu on one of its products."
        />
      ) : null}
      {loaded.status === "ready" && loaded.data.items.length > 0 ? (
        <ul aria-label="Blocked shops" className="flex flex-col gap-2">
          {loaded.data.items.map((b) => (
            <li
              key={b.companyId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-3"
            >
              <span className="flex min-w-0 flex-col">
                <a href={`/store/${b.handle}`} className="break-words font-medium text-action underline">
                  {b.displayName}
                </a>
                <span className="text-sm text-fg-muted">Blocked {formatWhen(b.blockedAt)}</span>
              </span>
              <Button
                variant="secondary"
                loading={busy === b.companyId}
                aria-label={`Unblock ${b.displayName}`}
                onClick={() => void unblock(b)}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
