"use client";

import { Alert, Badge, Button, FictionLabel, Heading, Price, StockBadge, Text } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, describeError, newIdempotencyKey, type ProductResponse } from "../_lib/api";
import { checkoutSellerId, isLow, leftCount, stockStateOf, storeNameOf } from "../_lib/catalog";
import { saveCheckoutContext } from "../_lib/checkout-context";
import { parsePaiseOrNull } from "../_lib/money";
import type { CompanyView } from "../_lib/selling";
import { nextOnboardingPath, useSession } from "../_lib/session-store";
import { requestQuote } from "../_lib/start-checkout";
import { AddToCartButton } from "./AddToCartButton";
import { SaveToggle } from "./SaveToggle";

interface Overlay {
  owned: string[];
  balancePaise: string | null;
}

/**
 * The purchase column of a public product page. The page itself is static; "owned" and the
 * person's balance arrive here, in the browser, from /api/v1/me/overlay.
 */
export function BuyPanel({ product }: { product: ProductResponse }) {
  const router = useRouter();
  const session = useSession();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [ownListing, setOwnListing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intentKey = useRef<string | null>(null);
  const signedIn = session.status === "signedIn";

  useEffect(() => {
    if (!signedIn) {
      setOverlay(null);
      return;
    }
    let cancelled = false;
    api<Overlay>(`/api/v1/me/overlay?productIds=${product.id}`)
      .then((data) => {
        if (!cancelled) setOverlay(data);
      })
      .catch(() => {
        // the overlay is a convenience; buying still checks everything on the server
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, product.id]);

  // Is this the signed-in person's own listing? Their shop id is the product's seller key.
  useEffect(() => {
    if (!signedIn || !product.sellerKey || product.sellerKey === "SEED") {
      setOwnListing(false);
      return;
    }
    let cancelled = false;
    api<{ company: CompanyView | null }>("/api/v1/company")
      .then((data) => {
        if (!cancelled) setOwnListing(data.company?.id === product.sellerKey);
      })
      .catch(() => {
        // the server refuses a self-purchase anyway
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, product.sellerKey]);

  const owned = overlay?.owned.includes(product.id) ?? false;
  const balance = parsePaiseOrNull(overlay?.balancePaise);
  const sellerId = checkoutSellerId(product);
  const unavailable = !product.available;

  async function buyNow() {
    if (session.status !== "signedIn") {
      router.push(`/sign-in?next=${encodeURIComponent(`/p/${product.id}`)}`);
      return;
    }
    const next = nextOnboardingPath(session.onboarding, false);
    if (next !== "/account") {
      router.push(next);
      return;
    }
    if (sellerId === null) return;
    setPending(true);
    setError(null);
    // one key per click of Buy now; reused only if the same request is repeated after a transient failure
    intentKey.current ??= newIdempotencyKey();
    try {
      const quote = await requestQuote(product.id, sellerId, "STANDARD", intentKey.current);
      intentKey.current = null;
      saveCheckoutContext(quote.id, {
        productId: product.id,
        productName: product.name,
        category: product.category,
        sellerId,
        sellerName: storeNameOf(product),
        quotes: { STANDARD: quote },
        speed: "STANDARD",
      });
      router.push(`/checkout/${quote.id}`);
    } catch (err) {
      if (!(err instanceof ApiError) || !err.retryable) intentKey.current = null;
      if (err instanceof ApiError && err.code === "AUTH_REQUIRED") {
        router.push(`/sign-in?next=${encodeURIComponent(`/p/${product.id}`)}`);
        return;
      }
      if (err instanceof ApiError && err.code === "ALREADY_OWNED") {
        setOverlay((o) => ({ owned: [product.id], balancePaise: o?.balancePaise ?? null }));
      }
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StockBadge {...stockStateOf(product)} />
        {product.edition && !unavailable && product.edition.supply - product.edition.issued <= 5 ? (
          <StockBadge state="low" count={leftCount(product) ?? 0} />
        ) : isLow(product) ? (
          <Badge tone="warning">Only a few left</Badge>
        ) : null}
        {owned ? <Badge tone="success">You own this</Badge> : null}
      </div>

      {product.edition ? (
        <Text size="sm" muted>
          Exclusive edition: {product.edition.issued} of {product.edition.supply} issued. The supply is fixed
          and will never grow.
        </Text>
      ) : null}

      {signedIn && balance !== null ? (
        <Text size="sm" muted>
          Your balance: <Price amountPaise={balance} display="exact" />{" "}
          <FictionLabel>fictional money</FictionLabel>
        </Text>
      ) : null}

      <Heading level={2} size="sm">
        Delivery
      </Heading>
      <Text size="sm" muted>
        Standard delivery is always available. You choose the speed at checkout.
      </Text>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {sellerId === null && !ownListing ? (
        <Alert tone="warning">Buying from creator shops is not open from this page yet.</Alert>
      ) : null}

      {ownListing ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
          <Text>This is your listing.</Text>
          <Button asChild variant="secondary" className="self-start">
            <a href={`/studio/${product.id}`}>Manage it in the studio</a>
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {owned ? (
            <>
              <Button size="lg" disabled aria-describedby="owned-hint">
                Already in your collection
              </Button>
              <Text as="span" size="sm" muted id="owned-hint">
                Each product can be owned once.{" "}
                <a className="text-action underline" href="/account/collection">
                  See your collection
                </a>
              </Text>
            </>
          ) : (
            <Button
              size="lg"
              loading={pending || session.status === "loading"}
              disabled={unavailable || sellerId === null}
              onClick={() => void buyNow()}
            >
              Buy now
            </Button>
          )}
          <AddToCartButton
            productId={product.id}
            name={product.name}
            available={product.available}
            owned={owned}
          />
          <div className="flex items-center gap-2">
            <SaveToggle productId={product.id} name={product.name} />
            <Text as="span" size="sm" muted>
              Save it to find it later.
            </Text>
          </div>
        </div>
      )}
    </div>
  );
}
