"use client";

import {
  Alert,
  Badge,
  DecisionForm,
  EmptyState,
  FilterTabs,
  Heading,
  Pagination,
  StarRating,
  Text,
} from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../_lib/api";
import { type AdminReviewItem, type AdminReviewsResponse, formatReviewDay } from "../../_lib/reviews";
import { studioErrorText } from "../../_lib/studio";
import { PageHeading } from "../PageHeading";
import { type ConsoleAccess, ConsoleFrame, ConsoleGate, isDenied } from "./ConsoleFrame";

type Filter = "ALL" | "HIDDEN";

/** /console/reviews: the newest reviews, with hide and restore (Super Admin only; audited). */
export function ReviewsScreen() {
  const [access, setAccess] = useState<ConsoleAccess>("checking");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminReviewsResponse | null>(null);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<AdminReviewsResponse>(`/api/v1/admin/reviews?filter=${filter}&page=${page}`));
      setAccess("allowed");
    } catch (error) {
      if (isDenied(error)) setAccess("denied");
      else {
        setMessage(studioErrorText(error));
        setAccess("error");
      }
    }
  }, [filter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (access !== "allowed" || data === null)
    return (
      <ConsoleGate
        access={access === "allowed" ? "checking" : access}
        message={message}
        onRetry={() => void load()}
      />
    );

  return (
    <ConsoleFrame current="/console/reviews">
      <div className="flex flex-col gap-6">
        <PageHeading>Reviews</PageHeading>
        <span role="status" aria-live="polite" className="sr-only">
          {notice ?? ""}
        </span>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <FilterTabs
          label="Which reviews"
          value={filter}
          options={[
            { key: "ALL", label: "All" },
            { key: "HIDDEN", label: "Hidden" },
          ]}
          onChange={(v) => {
            setFilter(v as Filter);
            setPage(1);
          }}
        />
        <Text size="sm" muted>
          Newest first. Hiding takes a review out of the product page and its rating at once; the author still
          sees it, with your reason.
        </Text>
        {data.items.length === 0 ? (
          <EmptyState title="No reviews" description="Reviews players write appear here." headingLevel={2} />
        ) : (
          <ul aria-label="Reviews" className="flex flex-col gap-4">
            {data.items.map((r) => (
              <li key={r.reviewId}>
                <ReviewCard
                  r={r}
                  onDone={(text) => {
                    setNotice(text);
                    void load();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {data.totalPages > 1 ? (
          <Pagination page={data.page} pageCount={data.totalPages} onPageChange={(p) => setPage(p)} />
        ) : null}
      </div>
    </ConsoleFrame>
  );
}

function ReviewCard({ r, onDone }: { r: AdminReviewItem; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = r.productName ?? "Product";

  async function decide(action: "hide" | "restore", reason: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/admin/reviews/${r.reviewId}/${action}`, { method: "POST", body: { reason } });
      onDone(`${action === "hide" ? "Hidden" : "Restored"}: a review of ${name}.`);
    } catch (e) {
      setError(studioErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      aria-label={`Review of ${name}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={3} size="sm" className="break-words">
          <a className="text-action underline" href={`/p/${r.productId}`}>
            {name}
          </a>
        </Heading>
        {r.hidden ? (
          <Badge tone="danger">Hidden</Badge>
        ) : r.public ? (
          <Badge tone="success">Public</Badge>
        ) : (
          <Badge tone="info">Not yet public</Badge>
        )}
      </div>
      <StarRating averageTenths={r.rating * 10} label={`Rated ${r.rating} out of 5`} size="sm" />
      {r.title ? <p className="font-medium break-words">{r.title}</p> : null}
      {r.body ? <p className="whitespace-pre-wrap break-words text-sm">{r.body}</p> : null}
      <Text size="sm" muted>
        {r.handle ? `@${r.handle}` : "Verified owner"} · {formatReviewDay(r.createdOn)}
        {r.edited ? " · Edited" : ""}
      </Text>
      {r.hidden && r.hiddenReason ? <Text size="sm">Hidden because: {r.hiddenReason}</Text> : null}
      <DecisionForm
        label={`review of ${name}`}
        hint="The author sees this reason. It is kept in the audit log."
        options={
          r.hidden
            ? [{ value: "restore", label: "Restore", variant: "secondary" }]
            : [{ value: "hide", label: "Hide", variant: "danger" }]
        }
        busy={busy}
        error={error}
        onDecide={(action, reason) => void decide(action as "hide" | "restore", reason)}
      />
    </article>
  );
}
