"use client";

import { Alert, Badge, Button, DataTable, Heading, Switch, Text, WarehouseUsage } from "@delulu/ui";
import { useState } from "react";
import { api } from "../../_lib/api";
import type { InventoryResponse } from "../../_lib/merchant";
import { studioErrorText } from "../../_lib/studio";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PortalTitle } from "./PortalTitle";

/** /studio/inventory: warehouse space, the Zap hub (its real state), and stock for every product. */
export function StudioInventory() {
  const loaded = useApiGet<InventoryResponse>("/api/v1/studio/inventory");
  return (
    <div className="flex flex-col gap-6">
      <PortalTitle>Inventory</PortalTitle>
      {loaded.status === "loading" ? <LoadingBlock rows={3} label="Loading your inventory" /> : null}
      {loaded.status === "error" ? <ErrorBlock message={loaded.message} onRetry={loaded.reload} /> : null}
      {loaded.status === "ready" ? <Body inventory={loaded.data} reload={loaded.reload} /> : null}
    </div>
  );
}

const MODE_LABEL = {
  STANDARD_STOCKED: "Standard stock",
  EXCLUSIVE: "Exclusive edition",
  UNLIMITED_SEED: "Unlimited",
} as const;

function Body({ inventory, reload }: { inventory: InventoryResponse; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const starter = inventory.warehouses.find((w) => w.kind === "STARTER") ?? inventory.warehouses[0];

  async function setHub(enabled: boolean) {
    if (!starter) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/v1/studio/warehouses/${starter.id}/zap-hub`, { method: "POST", body: { enabled } });
      setMessage({ tone: "success", text: enabled ? "Zap hub is on." : "Zap hub is off." });
      reload();
    } catch (error) {
      setMessage({ tone: "danger", text: studioErrorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section
        aria-labelledby="inv-space"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <Heading level={2} size="sm" id="inv-space">
          Warehouse space
        </Heading>
        {inventory.warehouses.length === 0 ? (
          <Text muted>Your starter warehouse is being set up.</Text>
        ) : null}
        {inventory.warehouses.map((w, i) => (
          <div key={w.id} className="flex flex-col gap-1">
            <WarehouseUsage
              used={w.used}
              capacity={w.capacity}
              name={i === 0 ? "Starter warehouse" : `Warehouse ${i + 1}`}
            />
            <Text size="sm" muted>
              {w.used} used, {w.free} free, {w.capacity} in total. Every unsold unit uses one slot.
            </Text>
          </div>
        ))}
      </section>

      <section
        aria-labelledby="inv-zap"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <Heading level={2} size="sm" id="inv-zap">
          Zap hub
        </Heading>
        <Text size="sm" muted>
          A Zap hub lets your products offer Zap delivery in 10 minutes. You can have one hub.
        </Text>
        {starter ? (
          <div className="flex items-center gap-3">
            <Switch
              aria-label="Zap hub"
              checked={starter.zapHub}
              disabled={busy}
              onCheckedChange={(on) => void setHub(on)}
            />
            <Text size="sm">
              Zap hub is currently <strong>{starter.zapHub ? "on" : "off"}</strong>.
            </Text>
          </div>
        ) : null}
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      </section>

      <section aria-labelledby="inv-products" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="inv-products">
          Stock by product
        </Heading>
        <Text size="sm" muted>
          A product is low on stock at {inventory.lowStockThreshold} units or fewer.
        </Text>
        <DataTable
          caption="Stock by product"
          emptyTitle="No products yet"
          emptyDescription="Stock appears here once you make a listing."
          rows={inventory.products}
          rowKey={(p) => p.id}
          columns={[
            { key: "name", header: "Product", cell: (p) => <span className="break-words">{p.name}</span> },
            {
              key: "mode",
              header: "Supply",
              cell: (p) =>
                p.edition
                  ? `Exclusive: ${p.edition.issued} of ${p.edition.supply} issued`
                  : MODE_LABEL[p.inventoryMode],
            },
            { key: "available", header: "Available", align: "right", cell: (p) => p.available },
            { key: "issued", header: "Issued", align: "right", cell: (p) => p.issued },
            { key: "retired", header: "Retired", align: "right", cell: (p) => p.retired },
            {
              key: "flag",
              header: "Stock level",
              cell: (p) =>
                p.lowStock ? (
                  <Badge tone="warning">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 12 12"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path d="M6 1.5L11 10.5H1Z" />
                      <path d="M6 5V7.5M6 9V9.1" />
                    </svg>
                    Low stock
                  </Badge>
                ) : (
                  "OK"
                ),
            },
          ]}
        />
      </section>
      <Button asChild variant="secondary" className="self-start">
        <a href="/studio/products">Manage listings</a>
      </Button>
    </>
  );
}
