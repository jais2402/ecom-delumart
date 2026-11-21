"use client";

import {
  FictionLabel,
  Heading,
  Pagination,
  Price,
  type StatementRow,
  StatementTable,
  Text,
} from "@delulu/ui";
import { useEffect, useState } from "react";
import { api, describeError, type StatementItem, type WalletResponse } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

interface Page {
  items: StatementItem[];
  nextCursor: string | null;
}

const PAGE_SIZE = 10;

const EVENT_TEXT: Record<string, string> = {
  STARTING_GRANT: "Welcome grant",
  PURCHASE: "Purchase",
  REFUND: "Refund",
};

function describe(item: StatementItem): string {
  return item.memo ?? EVENT_TEXT[item.eventType] ?? item.eventType.toLowerCase().replaceAll("_", " ");
}

export function WalletPanel() {
  const wallet = useApiGet<WalletResponse>("/api/v1/wallet");
  // cursors[i] is the cursor that loads page i + 1; page 1 has none
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick retries the same page
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPage(null);
    const cursor = cursors[pageIndex];
    api<Page>(`/api/v1/statement?limit=${PAGE_SIZE}${cursor ? `&cursor=${cursor}` : ""}`)
      .then((data) => {
        if (cancelled) return;
        setPage(data);
        setCursors((known) =>
          data.nextCursor && known.length === pageIndex + 1 ? [...known, data.nextCursor] : known,
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pageIndex, cursors, tick]);

  const rows: StatementRow[] =
    page?.items.map((item) => ({
      id: item.postingId,
      date: formatWhen(item.createdAt),
      dateTime: item.createdAt,
      description: describe(item),
      amountPaise: parsePaise(item.amountPaise),
      balanceAfterPaise: parsePaise(item.balanceAfterPaise),
    })) ?? [];
  const pageCount = Math.max(pageIndex + 1, cursors.length);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Wallet</PageHeading>
      {wallet.status === "loading" ? <LoadingBlock rows={1} label="Loading your balance" /> : null}
      {wallet.status === "error" ? <ErrorBlock message={wallet.message} onRetry={wallet.reload} /> : null}
      {wallet.status === "ready" ? (
        <section aria-label="Balance" className="flex flex-col gap-1 rounded-lg bg-action-soft p-4">
          <Text size="sm" muted>
            Balance
          </Text>
          <Price
            amountPaise={parsePaise(wallet.data.balancePaise)}
            display="exact"
            className="font-display text-3xl"
          />
          <FictionLabel>Fictional money</FictionLabel>
          <Text size="sm" muted>
            Bank alias {wallet.data.bankAlias} · DeluluPay id {wallet.data.delulupayId}
          </Text>
        </section>
      ) : null}

      <section aria-labelledby="statement" className="flex flex-col gap-3">
        <Heading level={2} size="md" id="statement">
          Statement
        </Heading>
        {error ? <ErrorBlock message={error} onRetry={() => setTick((n) => n + 1)} /> : null}
        {!error && page === null ? <LoadingBlock rows={4} label="Loading your statement" /> : null}
        {page !== null ? <StatementTable rows={rows} caption="Account statement, newest first" /> : null}
        {page !== null && (pageIndex > 0 || page.nextCursor) ? (
          <Pagination page={pageIndex + 1} pageCount={pageCount} onPageChange={(p) => setPageIndex(p - 1)} />
        ) : null}
      </section>
    </div>
  );
}
