"use client";

import {
  Alert,
  Button,
  CartLines,
  type CartSellerGroup,
  CouponInput,
  DeliveryChoice,
  Heading,
  OrderSummary,
  Price,
  Text,
} from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LoadingBlock } from "../_components/LoadState";
import {
  ApiError,
  api,
  describeError,
  newIdempotencyKey,
  type PreviewResponse,
  type QuoteResponse,
  type Speed,
} from "../_lib/api";
import {
  checkoutBlock,
  couponText,
  effectiveSpeeds,
  issueText,
  previewErrorText,
  previewTotals,
} from "../_lib/cart-pricing";
import { markCartChanged, useCart } from "../_lib/cart-store";
import { storeNameOf } from "../_lib/catalog";
import { saveCheckoutContext } from "../_lib/checkout-context";
import { parsePaise } from "../_lib/money";
import { nextOnboardingPath, useSession } from "../_lib/session-store";
import { isSpeed, SPEED_COPY } from "../_lib/speeds";
import { useProducts } from "../_lib/use-products";

export function CartScreen() {
  const session = useSession();
  const cart = useCart();
  const finished =
    session.status === "signedIn" && nextOnboardingPath(session.onboarding, false) === "/account";

  return (
    <div className="flex flex-col gap-4">
      <Heading level={1} size="lg">
        Your cart
      </Heading>
      {cart.changed ? (
        <Alert tone="warning" title="Some items in your cart changed">
          <p>Nothing was charged. The items that cannot be bought are marked below.</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={cart.dismissChanged}>
            Dismiss
          </Button>
        </Alert>
      ) : null}
      {session.status === "loading" ? (
        <LoadingBlock rows={2} label="Loading your cart" />
      ) : finished ? (
        <AccountCart />
      ) : (
        <LocalCart
          needsOnboarding={session.status === "signedIn"}
          onboardingHref={
            session.status === "signedIn" ? nextOnboardingPath(session.onboarding, false) : "/sign-in"
          }
        />
      )}
    </div>
  );
}

const shopLink = (
  <Button asChild>
    <a href="/">Shop DeluluMart</a>
  </Button>
);

// ------------------------------------------------------------------ signed out (or not onboarded)

/** Lines from the public catalog; totals need an account, so they appear after sign-in. */
function LocalCart({
  needsOnboarding,
  onboardingHref,
}: {
  needsOnboarding: boolean;
  onboardingHref: string;
}) {
  const cart = useCart();
  const { products, loading } = useProducts(cart.ids);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byStore = new Map<string, CartSellerGroup>();
    for (const id of cart.ids) {
      const product = products.get(id);
      if (product === undefined) continue;
      const store = product ? storeNameOf(product) : "DeluluMart";
      const group = byStore.get(store) ?? { sellerId: `store-${byStore.size}`, sellerName: store, lines: [] };
      const line = product
        ? {
            id,
            name: product.name,
            hue: product.templateId,
            quantity: 1,
            unitPricePaise: parsePaise(product.pricePaise),
            href: `/p/${id}`,
            imageAlt: product.altText,
            ...(product.available ? {} : { issue: "Sold out. Remove it to check out." }),
          }
        : {
            id,
            name: "An item that is no longer listed",
            hue: 0,
            quantity: 1,
            unitPricePaise: 0n,
            issue: "No longer available. Remove it to check out.",
          };
      byStore.set(store, { ...group, lines: [...group.lines, line] });
    }
    return [...byStore.values()];
  }, [cart.ids, products]);

  if (cart.ids.length === 0) {
    return <CartLines groups={[]} onRemove={() => {}} emptyAction={shopLink} />;
  }
  if (loading && groups.length === 0) return <LoadingBlock rows={2} label="Loading your cart" />;

  const blocked = groups.some((g) => g.lines.some((l) => l.issue));
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <CartLines
          groups={groups}
          onRemove={(id) => {
            setError(null);
            void cart.remove(id).catch((err: unknown) => setError(describeError(err)));
          }}
        />
      </div>
      <section
        aria-label="Checkout"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <Heading level={2} size="sm">
          Order summary
        </Heading>
        <Text size="sm" muted>
          {needsOnboarding
            ? "Finish setting up your account and your totals will appear here."
            : "Totals appear after you sign in. Your cart stays on this device and moves into your account."}
        </Text>
        <Button asChild size="lg" aria-disabled={blocked || undefined}>
          <a href={needsOnboarding ? onboardingHref : "/sign-in?next=%2Fcart"}>
            {needsOnboarding ? "Finish setting up your account" : "Sign in to check out"}
          </a>
        </Button>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ signed in

function AccountCart() {
  const router = useRouter();
  const cart = useCart();
  const server = cart.server;

  const [chosen, setChosen] = useState<Record<string, Speed>>({});
  const [couponCode, setCouponCode] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [speedError, setSpeedError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [status, setStatus] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const latest = useRef(0);
  const lastGood = useRef<PreviewResponse | null>(null);
  const checkoutKey = useRef<{ sig: string; key: string } | null>(null);

  const chosenKey = JSON.stringify(chosen);

  // Price the cart for the chosen options. Only the newest request may update the screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chosenKey stands for chosen
  useEffect(() => {
    if (!server) return;
    const keys = new Set(server.groups.map((g) => g.sellerKey));
    const speedBySeller = Object.fromEntries(Object.entries(chosen).filter(([key]) => keys.has(key)));
    const mine = ++latest.current;
    if (Object.keys(speedBySeller).length === 0 && couponCode === null) {
      setPreview(server.preview);
      lastGood.current = server.preview;
      setPreviewError(server.previewError ? previewErrorText(server.previewError) : null);
      setLoadingPreview(false);
      return;
    }
    setLoadingPreview(true);
    api<PreviewResponse>("/api/v1/cart/preview", {
      method: "POST",
      body: {
        ...(Object.keys(speedBySeller).length > 0 ? { speedBySeller } : {}),
        ...(couponCode === null ? {} : { couponCode }),
      },
    })
      .then((next) => {
        if (mine !== latest.current) return;
        lastGood.current = next;
        setPreview(next);
        setPreviewError(null);
        setLoadingPreview(false);
        setStatus("Your total was updated.");
      })
      .catch((err: unknown) => {
        if (mine !== latest.current) return;
        setLoadingPreview(false);
        const code = err instanceof ApiError ? err.code : null;
        setSpeedError(previewErrorText(code));
        // go back to the options the last good total was priced with
        const good = lastGood.current;
        if (good) setChosen(effectiveSpeeds(good, {}));
      });
  }, [server, chosenKey, couponCode]);

  // the cart's lines, for the checkout's idempotency key: one key per set of lines and options
  const sig = useMemo(
    () =>
      server
        ? server.groups
            .map((g) => `${g.sellerKey}:${g.lines.map((l) => `${l.productId}${l.issue ?? ""}`).join(",")}`)
            .join("|")
        : "",
    [server],
  );

  if (cart.loadError && !server) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert tone="danger" title="Your cart did not load">
          {cart.loadError}
        </Alert>
        <Button variant="secondary" onClick={() => void cart.refresh()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!server) return <LoadingBlock rows={2} label="Loading your cart" />;
  if (server.lineCount === 0) return <CartLines groups={[]} onRemove={() => {}} emptyAction={shopLink} />;

  const issueLines = server.groups.flatMap((g) => g.lines.filter((l) => l.issue !== null));
  const speeds = effectiveSpeeds(preview, chosen);
  // every offered speed's fee comes with the preview (POST /cart/preview speedOptions)
  const fees: Record<string, bigint> = {};
  for (const s of preview?.sellers ?? []) {
    for (const o of s.speedOptions ?? []) fees[`${s.sellerKey}:${o.speed}`] = parsePaise(o.deliveryFeePaise);
    fees[`${s.sellerKey}:${s.speed}`] = parsePaise(s.deliveryFeePaise);
  }
  const previewSellers = new Map((preview?.sellers ?? []).map((s) => [s.sellerKey, s]));

  const groups: CartSellerGroup[] = server.groups.map((g) => {
    const priced = previewSellers.get(g.sellerKey);
    const offered = priced?.speedsOffered ?? [];
    return {
      sellerId: g.sellerKey,
      sellerName: g.sellerName,
      lines: g.lines.map((l) => ({
        id: l.productId,
        name: l.name,
        hue: l.templateId,
        quantity: 1,
        unitPricePaise: parsePaise(l.pricePaise),
        href: `/p/${l.productId}`,
        imageAlt: l.altText,
        ...(l.issue ? { issue: issueText(l.issue) } : {}),
      })),
      ...(priced && offered.length > 0
        ? {
            footer: (
              <DeliveryChoice
                sellerName={g.sellerName}
                name={`delivery-${g.sellerKey}`}
                value={speeds[g.sellerKey] ?? priced.speed}
                options={offered.map((speed) => ({
                  value: speed,
                  speedName: SPEED_COPY[speed].name,
                  arrival: SPEED_COPY[speed].arrival,
                  feePaise: fees[`${g.sellerKey}:${speed}`] ?? null,
                }))}
                onChange={(value) => {
                  if (!isSpeed(value)) return;
                  setSpeedError(null);
                  setChosen((c) => ({ ...effectiveSpeeds(preview, c), [g.sellerKey]: value }));
                }}
              />
            ),
          }
        : {}),
    };
  });

  const block = checkoutBlock({
    issueCount: issueLines.length,
    preview,
    previewError: previewError !== null,
    loading: loadingPreview,
  });
  const totals = preview ? previewTotals(preview) : null;

  async function removeUnavailable() {
    setActionError(null);
    const names = issueLines.length;
    try {
      for (const line of issueLines) await cart.remove(line.productId);
      setStatus(`Removed ${names} unavailable ${names === 1 ? "item" : "items"}.`);
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function checkout() {
    if (block !== null || paying || !preview || !server) return;
    setPaying(true);
    setActionError(null);
    const speedBySeller = effectiveSpeeds(preview, chosen);
    const applied = preview.couponCode;
    const signature = JSON.stringify({ speedBySeller, applied, lines: sig });
    if (checkoutKey.current?.sig !== signature)
      checkoutKey.current = { sig: signature, key: newIdempotencyKey() };
    try {
      const quote = await api<QuoteResponse>("/api/v1/checkout-sessions", {
        method: "POST",
        idempotencyKey: checkoutKey.current.key,
        body: { source: "CART", speedBySeller, ...(applied ? { couponCode: applied } : {}) },
      });
      checkoutKey.current = null;
      const live = server.groups.filter((g) => g.lines.some((l) => l.issue === null));
      const first = live[0]?.lines[0];
      saveCheckoutContext(quote.id, {
        cart: {
          groups: live.map((g) => ({
            sellerKey: g.sellerKey,
            sellerName: g.sellerName,
            itemNames: g.lines.filter((l) => l.issue === null).map((l) => l.name),
          })),
          couponCode: applied,
        },
        productId: first?.productId ?? "",
        productName: `${preview.sellers.reduce((n, s) => n + s.productIds.length, 0)} items`,
        category: first?.category ?? "",
        sellerId: live[0]?.sellerKey ?? "",
        quotes: { STANDARD: quote },
        speed: "STANDARD",
      });
      router.push(`/checkout/${quote.id}`);
    } catch (err) {
      if (err instanceof ApiError && !err.retryable) checkoutKey.current = null;
      if (err instanceof ApiError && err.code === "AUTH_REQUIRED") {
        router.push("/sign-in?next=%2Fcart");
        return;
      }
      if (err instanceof ApiError && err.code === "CART_CHANGED") {
        await markCartChanged();
        setPaying(false);
        return;
      }
      setActionError(
        err instanceof ApiError && err.code === "INSUFFICIENT_FUNDS"
          ? "Not enough balance for this order. Nothing was charged."
          : `${describeError(err)} Nothing was charged.`,
      );
    }
    setPaying(false);
  }

  const reason =
    block === null
      ? null
      : block.kind === "issues"
        ? "Remove the unavailable items to check out."
        : block.kind === "empty"
          ? "Nothing in your cart can be bought right now."
          : block.kind === "pricing"
            ? "We cannot work out your total right now."
            : block.kind === "loading"
              ? "Updating your total…"
              : null;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      <div className="flex min-w-0 flex-col gap-4">
        {issueLines.length > 0 ? (
          <Alert tone="danger" title="Some items cannot be bought">
            <p>They are marked below and left out of your total. Nothing has been charged.</p>
            <Button variant="secondary" className="mt-2" onClick={() => void removeUnavailable()}>
              Remove unavailable items
            </Button>
          </Alert>
        ) : null}
        {previewError ? <Alert tone="warning">{previewError}</Alert> : null}
        {speedError ? <Alert tone="warning">{speedError}</Alert> : null}
        {actionError ? <Alert tone="danger">{actionError}</Alert> : null}
        <CartLines
          groups={groups}
          onRemove={(id) => {
            setActionError(null);
            void cart.remove(id).catch((err: unknown) => setActionError(describeError(err)));
          }}
        />
        {server.lineCount >= server.maxLines ? (
          <Text size="sm" muted>
            Your cart is full ({server.maxLines} items).
          </Text>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <section
          aria-label="Coupon"
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
        >
          <Heading level={2} size="sm">
            Coupon
          </Heading>
          <CouponInput
            loading={loadingPreview && couponCode !== null && preview?.couponCode == null}
            {...(preview?.couponCode ? { appliedCode: preview.couponCode } : {})}
            {...(couponText(preview?.couponError ?? null)
              ? { error: couponText(preview?.couponError ?? null) as string }
              : {})}
            onApply={(code) => setCouponCode(code)}
            onRemove={() => setCouponCode(null)}
          />
        </section>

        {totals ? (
          <OrderSummary
            itemsTotalPaise={totals.items}
            discountPaise={totals.discount}
            deliveryFeePaise={totals.delivery}
            totalPaise={totals.total}
            balanceAfterPaise={totals.balanceAfter}
            loading={loadingPreview}
            footer={
              <div className="flex flex-col gap-2">
                {block?.kind === "balance" ? (
                  <p className="text-sm font-medium text-danger">
                    Not enough balance. You are short by{" "}
                    <Price amountPaise={block.shortfall} display="exact" className="text-danger" />.
                  </p>
                ) : reason ? (
                  <p id="checkout-reason" className="text-sm text-fg-muted">
                    {reason}
                  </p>
                ) : null}
                <Button
                  size="lg"
                  loading={paying}
                  aria-disabled={block !== null || undefined}
                  aria-describedby={block !== null ? "checkout-reason" : undefined}
                  onClick={() => void checkout()}
                >
                  Check out
                </Button>
              </div>
            }
          />
        ) : (
          <Alert tone="warning">We could not price your cart yet. Try again in a moment.</Alert>
        )}
      </div>
    </div>
  );
}
