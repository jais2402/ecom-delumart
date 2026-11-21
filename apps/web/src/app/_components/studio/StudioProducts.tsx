"use client";

import {
  Alert,
  Button,
  DataTable,
  EmptyState,
  ListingStatus,
  type ListingStatusValue,
  Pagination,
  Price,
  Select,
  Text,
} from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import { countCaps, LISTING_CAPS, type Listing, type ListingPage, type NextAction } from "../../_lib/studio";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

const PAGE_SIZE = 10;

const STATUS_OPTIONS: { value: "" | ListingStatusValue; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "SCREENING", label: "Being checked" },
  { value: "NEEDS_REVIEW", label: "In review" },
  { value: "PUBLISHED", label: "Published" },
  { value: "REJECTED", label: "Not approved" },
  { value: "HIDDEN", label: "Hidden" },
  { value: "ARCHIVED", label: "Archived" },
];

const ACTION_LABEL: Record<NextAction, string> = {
  SUBMIT: "Finish and submit",
  ALLOCATE_STOCK: "Add stock and publish",
  WAIT_FOR_SCREENING: "Check progress",
  WAIT_FOR_REVIEW: "Check progress",
  EDIT_AND_RESUBMIT: "Edit and resubmit",
  HIDDEN_BY_MODERATION: "See why",
  WAIT_FOR_REVISION: "Check revision",
  RESTOCK: "Restock",
  NONE: "Open",
};

/** The live version if there is one, else what is waiting, else the latest draft. */
function shown(l: Listing) {
  return l.live ?? l.pending?.version ?? l.current;
}

async function loadAll(signal: AbortSignal): Promise<Listing[]> {
  const all: Listing[] = [];
  let cursor: string | null = null;
  do {
    const page: ListingPage = await api<ListingPage>(
      `/api/v1/studio/products?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
      { signal },
    );
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** /studio: every listing of the shop, with its status, price, stock and what to do next. */
export function StudioProducts() {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: Listing[] }
  >({ status: "loading" });
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<"" | ListingStatusValue>("");
  const [page, setPage] = useState(1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick retries the load
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loadAll(controller.signal)
      .then((items) => setState({ status: "ready", items }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: describeError(error) });
      });
    return () => controller.abort();
  }, [tick]);

  const retry = useCallback(() => setTick((n) => n + 1), []);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading>Your products</PageHeading>
        <LoadingBlock rows={4} label="Loading your products" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading>Your products</PageHeading>
        <ErrorBlock message={state.message} onRetry={retry} />
      </div>
    );
  }

  const caps = countCaps(state.items);
  const filtered = state.items.filter((l) => filter === "" || l.status === filter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading>Your products</PageHeading>
        <Button asChild>
          <a href="/studio/new">New listing</a>
        </Button>
      </div>
      <Text size="sm" muted data-testid="caps">
        {caps.drafts} of {LISTING_CAPS.drafts} drafts · {caps.published} of {LISTING_CAPS.published} published
      </Text>

      {state.items.length === 0 ? (
        <EmptyState
          title="No listings yet"
          description="Make your first listing: a name, a price, some stock. You can save it as a draft and finish later."
          action={
            <Button asChild>
              <a href="/studio/new">Create your first listing</a>
            </Button>
          }
        />
      ) : (
        <>
          <div className="max-w-xs">
            <label htmlFor="status-filter" className="mb-1 block text-sm font-medium text-fg">
              Filter by status
            </label>
            <Select
              id="status-filter"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as "" | ListingStatusValue);
                setPage(1);
              }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          {filtered.length === 0 ? (
            <Alert tone="info">No listings with that status.</Alert>
          ) : (
            <DataTable
              caption="Your listings"
              rows={rows}
              rowKey={(l) => l.id}
              columns={[
                {
                  key: "name",
                  header: "Name",
                  cell: (l) => (
                    <a
                      href={`/studio/${l.id}`}
                      className="inline-flex min-h-touch items-center break-words font-medium text-action underline"
                    >
                      {shown(l)?.name ?? "Untitled draft"}
                    </a>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  cell: (l) => (
                    <ListingStatus status={l.status} approvedNeedsStock={l.approvedNeedsStock} compact />
                  ),
                },
                {
                  key: "price",
                  header: "Price",
                  align: "right",
                  cell: (l) => {
                    const v = shown(l);
                    return v ? <Price amountPaise={parsePaise(v.pricePaise)} /> : "—";
                  },
                },
                {
                  key: "stock",
                  header: "Stock (available / issued)",
                  cell: (l) =>
                    l.status === "PUBLISHED" || l.stock.issued > 0
                      ? `${l.stock.available} / ${l.stock.issued}${l.edition ? ` of ${l.edition.supply}` : ""}`
                      : "—",
                },
                {
                  key: "updated",
                  header: "Updated",
                  cell: (l) => formatWhen(l.updatedAt ?? l.createdAt),
                },
                {
                  key: "next",
                  header: "Next",
                  cell: (l) => (
                    <Button asChild variant="secondary" size="sm">
                      <a
                        href={`/studio/${l.id}`}
                        aria-label={`${ACTION_LABEL[l.nextAction]}: ${shown(l)?.name ?? "untitled draft"}`}
                      >
                        {ACTION_LABEL[l.nextAction]}
                      </a>
                    </Button>
                  ),
                },
              ]}
            />
          )}
          {pageCount > 1 ? <Pagination page={current} pageCount={pageCount} onPageChange={setPage} /> : null}
        </>
      )}
    </div>
  );
}
