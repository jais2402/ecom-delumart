"use client";

import { Badge, Button, EmptyState, FictionLabel, Heading, Price, StatGrid, Text } from "@delulu/ui";
import type { OrderResponse, WalletResponse } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";
import { OrderRow } from "./OrderRow";

export function OverviewPanel() {
  const wallet = useApiGet<WalletResponse>("/api/v1/wallet");
  const orders = useApiGet<{ items: OrderResponse[] }>("/api/v1/orders?limit=3");

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Your account</PageHeading>

      {wallet.status === "loading" ? <LoadingBlock rows={2} label="Loading your balance" /> : null}
      {wallet.status === "error" ? <ErrorBlock message={wallet.message} onRetry={wallet.reload} /> : null}
      {wallet.status === "ready" ? (
        <section aria-label="Balance and card" className="flex flex-col gap-3">
          <StatGrid
            stats={[
              {
                label: "Balance",
                value: (
                  <Price
                    amountPaise={parsePaise(wallet.data.balancePaise)}
                    display="exact"
                    className="font-display text-2xl"
                  />
                ),
                asOf: "Fictional money",
              },
              {
                label: "Delulu Card",
                value: wallet.data.card ? `•••• ${wallet.data.card.lastFour}` : "No card",
                change: wallet.data.card ? (
                  <Badge tone={wallet.data.card.status === "FROZEN" ? "info" : "success"}>
                    {wallet.data.card.status === "FROZEN" ? "Frozen" : "Active"}
                  </Badge>
                ) : undefined,
              },
            ]}
          />
          <FictionLabel>Fictional money. Nothing here is real.</FictionLabel>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <a href="/account/wallet">Wallet and statement</a>
            </Button>
            <Button asChild variant="secondary">
              <a href="/account/cards">Manage card</a>
            </Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="recent-orders" className="flex flex-col gap-3">
        <Heading level={2} size="md" id="recent-orders">
          Recent orders
        </Heading>
        {orders.status === "loading" ? <LoadingBlock rows={2} label="Loading recent orders" /> : null}
        {orders.status === "error" ? <ErrorBlock message={orders.message} onRetry={orders.reload} /> : null}
        {orders.status === "ready" && orders.data.items.length === 0 ? (
          <EmptyState
            title="No orders yet"
            description="Your first purchase will show up here."
            action={
              <Button asChild>
                <a href="/">Start shopping</a>
              </Button>
            }
          />
        ) : null}
        {orders.status === "ready" && orders.data.items.length > 0 ? (
          <>
            <ul className="flex flex-col gap-3">
              {orders.data.items.map((order) => (
                <li key={order.id}>
                  <OrderRow order={order} />
                </li>
              ))}
            </ul>
            <Text size="sm" muted>
              Latest order placed {formatWhen(orders.data.items[0]?.createdAt ?? "")}.{" "}
              <a className="text-action underline" href="/account/orders">
                See all orders
              </a>
            </Text>
          </>
        ) : null}
      </section>
    </div>
  );
}
