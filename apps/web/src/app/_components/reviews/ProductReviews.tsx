"use client";

import { Alert, Badge, Button, EmptyState, Heading, Pagination, StarRating, Text } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../../_lib/api";
import {
  formatReviewDay,
  ineligibleText,
  type MyReviewResponse,
  type OwnReviewView,
  type ProductReviewsResponse,
} from "../../_lib/reviews";
import { useSession } from "../../_lib/session-store";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { ReviewForm } from "./ReviewForm";
import { ReviewList } from "./ReviewList";
import { ReviewSummary } from "./ReviewSummary";

/**
 * The product page's "Ratings and reviews" section (docs/decisions.md #14). Self-contained: give it
 * the product id. The public reviews come from the public, cacheable route; the signed-in person's
 * own review and whether they may write one come from a separate private call, never mixed in.
 */
export function ProductReviews({ productId }: { productId: string }) {
  const session = useSession();
  const signedIn = session.status === "signedIn";
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ProductReviewsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mine, setMine] = useState<MyReviewResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadPublic = useCallback(async () => {
    try {
      setLoadError(null);
      setData(await api<ProductReviewsResponse>(`/api/v1/products/${productId}/reviews?page=${page}`));
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, [productId, page]);

  const loadMine = useCallback(async () => {
    if (!signedIn) {
      setMine(null);
      return;
    }
    try {
      setMine(await api<MyReviewResponse>(`/api/v1/me/reviews/${productId}`));
    } catch {
      setMine(null); // the overlay is a convenience; writing still checks everything on the server
    }
  }, [productId, signedIn]);

  useEffect(() => {
    void loadPublic();
  }, [loadPublic]);
  useEffect(() => {
    void loadMine();
  }, [loadMine]);

  function saved(review: OwnReviewView) {
    setEditing(false);
    setMine((m) => (m ? { ...m, review } : m));
    setNotice(
      review.public
        ? "Thanks. Your review is posted."
        : review.hidden
          ? "Saved. Your review stays hidden by moderation."
          : "Thanks. Your review will appear in a minute.",
    );
    void loadPublic();
  }

  async function remove() {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/api/v1/products/${productId}/review`, { method: "DELETE" });
      setMine((m) => (m ? { ...m, review: null } : m));
      setNotice("Your review is deleted.");
      void loadPublic();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const own = mine?.review ?? null;

  return (
    <section
      aria-labelledby="reviews-heading"
      className="flex flex-col gap-6 rounded-lg bg-surface p-5 md:p-6"
    >
      <Heading level={2} size="md" id="reviews-heading" className="text-2xl">
        Ratings and reviews
      </Heading>
      <span role="status" aria-live="polite" className="sr-only">
        {notice ?? ""}
      </span>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {actionError ? <Alert tone="danger">{actionError}</Alert> : null}

      {data === null ? (
        loadError ? (
          <ErrorBlock message={loadError} onRetry={() => void loadPublic()} />
        ) : (
          <LoadingBlock rows={2} label="Loading reviews" />
        )
      ) : (
        <ReviewSummary
          averageTenths={data.averageTenths}
          count={data.count}
          distribution={data.distribution}
        />
      )}

      {mine && (own || mine.eligible) ? (
        <div className="flex flex-col gap-3 rounded-md border border-border p-4">
          {editing ? (
            <ReviewForm
              productId={productId}
              existing={own}
              handle={mine.handle}
              onSaved={saved}
              onCancel={() => setEditing(false)}
            />
          ) : own ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Heading level={3} size="sm" className="text-lg">
                  Your review
                </Heading>
                {own.hidden ? <Badge tone="danger">Hidden by moderation</Badge> : null}
                {!own.hidden && !own.public ? <Badge tone="info">Appears shortly</Badge> : null}
              </div>
              <StarRating
                averageTenths={own.rating * 10}
                label={`You rated it ${own.rating} out of 5`}
                size="sm"
              />
              {own.title ? <Text className="font-medium break-words">{own.title}</Text> : null}
              {own.body ? <Text className="whitespace-pre-wrap break-words">{own.body}</Text> : null}
              <Text size="sm" muted>
                {formatReviewDay(own.createdOn)}
                {own.edited ? " · Edited" : ""}
              </Text>
              {own.hidden && own.hiddenReason ? <Text size="sm">Reason: {own.hiddenReason}</Text> : null}
              <div className="flex flex-wrap gap-2">
                {mine.eligible ? (
                  <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
                    Edit your review
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => void remove()} loading={busy}>
                  Delete your review
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Text>Bought it? Tell other players what you think.</Text>
              <Button onClick={() => setEditing(true)}>Write a review</Button>
            </div>
          )}
        </div>
      ) : mine && !mine.eligible && mine.reason === "SELLER" ? (
        <Text size="sm" muted>
          {ineligibleText(mine.reason)}
        </Text>
      ) : null}

      {data === null ? null : data.count === 0 ? (
        <EmptyState
          title="No reviews yet"
          description="Players who own this product can review it."
          headingLevel={3}
        />
      ) : (
        <>
          <ReviewList items={data.items} />
          {data.totalPages > 1 ? (
            <Pagination page={data.page} pageCount={data.totalPages} onPageChange={(p) => setPage(p)} />
          ) : null}
        </>
      )}
    </section>
  );
}
