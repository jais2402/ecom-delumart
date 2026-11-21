"use client";

import { Badge, DataTable, Text } from "@delulu/ui";
import { type MyReport, reasonLabel } from "../../_lib/merchant";
import { formatWhen } from "../../_lib/orders";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

const STATUS = {
  OPEN: { label: "Being looked at", tone: "info" },
  UPHELD: { label: "Acted on", tone: "success" },
  DISMISSED: { label: "Closed, no action", tone: "neutral" },
} as const;

/** /account/reports: the person's own reports and where each case stands. */
export function ReportsPanel() {
  const loaded = useApiGet<{ items: MyReport[] }>("/api/v1/reports");
  return (
    <div className="flex flex-col gap-4">
      <PageHeading>Your reports</PageHeading>
      <Text muted>Only you can see these. We do not tell the seller who reported.</Text>
      {loaded.status === "loading" ? <LoadingBlock rows={3} label="Loading your reports" /> : null}
      {loaded.status === "error" ? <ErrorBlock message={loaded.message} onRetry={loaded.reload} /> : null}
      {loaded.status === "ready" ? (
        <DataTable
          caption="Your reports"
          emptyTitle="No reports"
          emptyDescription="Reports you send from a product or shop page appear here."
          rows={loaded.data.items}
          rowKey={(r) => r.reference}
          columns={[
            {
              key: "ref",
              header: "Reference",
              cell: (r) => <code className="font-mono">{r.reference}</code>,
            },
            {
              key: "target",
              header: "About",
              cell: (r) => (r.targetType === "STORE" ? "A shop" : "A product"),
            },
            { key: "reason", header: "Reason", cell: (r) => reasonLabel(r.reason) },
            { key: "sent", header: "Sent", cell: (r) => formatWhen(r.createdAt) },
            {
              key: "status",
              header: "Status",
              cell: (r) => <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>,
            },
          ]}
        />
      ) : null}
    </div>
  );
}
