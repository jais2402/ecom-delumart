"use client";

import { Button, EmptyState } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api, describeError, type OrderResponse } from "../../_lib/api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";
import { OrderRow } from "./OrderRow";

interface Page {
  items: OrderResponse[];
  nextCursor: string | null;
}

const PAGE_SIZE = 10;

export function OrdersPanel() {
  const [orders, setOrders] = useState<OrderResponse[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const query = cursor ? `&cursor=${cursor}` : "";
      const page = await api<Page>(`/api/v1/orders?limit=${PAGE_SIZE}${query}`);
      setOrders((existing) => (cursor && existing ? [...existing, ...page.items] : page.items));
      setNext(page.nextCursor);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>Your orders</PageHeading>
      {orders === null && loading ? <LoadingBlock rows={3} label="Loading your orders" /> : null}
      {error ? <ErrorBlock message={error} onRetry={() => void load(orders === null ? null : next)} /> : null}
      {orders !== null && orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="When you buy something it will appear here."
          action={
            <Button asChild variant="cta">
              <a href="/">Start shopping</a>
            </Button>
          }
        />
      ) : null}
      {orders !== null && orders.length > 0 ? (
        <ul aria-label="Orders" className="flex flex-col gap-3">
          {orders.map((order) => (
            <li key={order.id}>
              <OrderRow order={order} />
            </li>
          ))}
        </ul>
      ) : null}
      {next ? (
        <Button variant="secondary" loading={loading} onClick={() => void load(next)} className="self-start">
          Load more orders
        </Button>
      ) : null}
    </div>
  );
}
