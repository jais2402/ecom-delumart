"use client";

import { Alert, Button, Heading, Text, WarehouseUsage } from "@delulu/ui";
import { useState } from "react";
import { api } from "../../_lib/api";
import { studioErrorText, type WarehouseSummary } from "../../_lib/studio";
import { PageHeading } from "../PageHeading";
import { useStudioCompany } from "./StudioShell";

/**
 * /studio/inventory: warehouse space and the Zap hub. The API does not say whether the hub is on
 * (the company view has no such field), so the page shows what it learns from its own changes.
 */
export function StudioInventory() {
  const company = useStudioCompany();
  const starter = company.warehouses.starter;
  const [warehouse, setWarehouse] = useState<WarehouseSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function setHub(enabled: boolean) {
    if (!starter) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ warehouses: WarehouseSummary[] }>(
        `/api/v1/studio/warehouses/${starter.id}/zap-hub`,
        { method: "POST", body: { enabled } },
      );
      setWarehouse(result.warehouses.find((w) => w.id === starter.id) ?? null);
      setMessage({
        tone: "success",
        text: enabled ? "Zap hub is on for your starter warehouse." : "Zap hub is off.",
      });
    } catch (error) {
      setMessage({ tone: "danger", text: studioErrorText(error) });
    } finally {
      setBusy(false);
    }
  }

  const used = warehouse?.used ?? starter?.used ?? 0;
  const capacity = warehouse?.capacity ?? starter?.capacity ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Inventory</PageHeading>
      <section
        aria-labelledby="inv-space"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <Heading level={2} size="sm" id="inv-space">
          Warehouse space
        </Heading>
        {starter ? (
          <>
            <WarehouseUsage used={used} capacity={capacity} />
            <Text size="sm" muted>
              Every unsold unit uses one slot. {Math.max(capacity - used, 0)} slots are free.
            </Text>
          </>
        ) : (
          <Text muted>Your starter warehouse is being set up.</Text>
        )}
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
        {warehouse ? (
          <Text size="sm">
            Zap hub is currently <strong>{warehouse.zapHub ? "on" : "off"}</strong>.
          </Text>
        ) : (
          <Text size="sm" muted>
            The current setting is shown after you change it.
          </Text>
        )}
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!starter || busy || warehouse?.zapHub === true} onClick={() => void setHub(true)}>
            Turn Zap hub on
          </Button>
          <Button
            variant="secondary"
            disabled={!starter || busy || warehouse?.zapHub === false}
            onClick={() => void setHub(false)}
          >
            Turn Zap hub off
          </Button>
        </div>
      </section>
    </div>
  );
}
