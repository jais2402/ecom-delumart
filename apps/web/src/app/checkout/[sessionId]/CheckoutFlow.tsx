"use client";

import {
  Alert,
  BankChallenge,
  Button,
  CheckoutLayout,
  CheckoutSteps,
  DeliveryOption,
  EmptyState,
  FictionLabel,
  Heading,
  OrderSummary,
  PaymentMethodOption,
  Price,
  SiteFooter,
  Spinner,
  Text,
} from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoadingBlock } from "../../_components/LoadState";
import { SessionHeader } from "../../_components/SessionHeader";
import {
  ApiError,
  api,
  describeError,
  newIdempotencyKey,
  type QuoteResponse,
  type ReceiptResponse,
  type Speed,
} from "../../_lib/api";
import {
  type CheckoutContext,
  clearCheckoutContext,
  loadCheckoutContext,
  markJustPaid,
  saveCheckoutContext,
} from "../../_lib/checkout-context";
import { parsePaise } from "../../_lib/money";
import { refreshSession } from "../../_lib/session-store";
import { requestQuote } from "../../_lib/start-checkout";
import { useRequireAccount } from "../../_lib/use-require-account";

type Step = "speed" | "payment" | "review";
type Method = "CARD" | "BALANCE";
type Phase = "idle" | "challenge" | "processing";

interface Notice {
  tone: "danger" | "warning" | "info";
  title: string;
  text: string;
  link?: { href: string; label: string };
  action?: { label: string; run: () => void };
}

const STEP_INDEX: Record<Step, number> = { speed: 1, payment: 2, review: 3 };
const SPEED_COPY: Record<Speed, { name: string; arrival: string }> = {
  STANDARD: { name: "Standard", arrival: "Arrives in about 24 hours" },
  EXPRESS: { name: "Express", arrival: "Arrives in about 2 hours" },
  ZAP: { name: "Zap", arrival: "Arrives in about 10 minutes" },
};
const ALTERNATIVES: readonly Speed[] = ["EXPRESS", "ZAP"];

function sellerOf(quote: QuoteResponse, sellerId: string) {
  return quote.sellers.find((s) => s.sellerId === sellerId) ?? quote.sellers[0];
}

export function CheckoutFlow({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { session, ok } = useRequireAccount();
  const [ctx, setCtx] = useState<CheckoutContext | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<Step>("speed");
  const [method, setMethod] = useState<Method>("CARD");
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pinError, setPinError] = useState<string | undefined>();
  const [unavailable, setUnavailable] = useState<ReadonlySet<Speed>>(new Set());
  const attemptId = useRef<string | null>(null);
  const payKey = useRef<string | null>(null);
  const working = useRef(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);

  const update = useCallback(
    (next: CheckoutContext) => {
      setCtx(next);
      saveCheckoutContext(sessionId, next);
    },
    [sessionId],
  );

  useEffect(() => {
    setCtx(loadCheckoutContext(sessionId));
    setLoaded(true);
  }, [sessionId]);

  // Other delivery speeds are separate quotes. Ask for them once; a refusal means "not offered".
  const alternativesAsked = useRef(false);
  useEffect(() => {
    if (!ok || !ctx || alternativesAsked.current) return;
    alternativesAsked.current = true;
    const current = ctx;
    void (async () => {
      let latest = current;
      for (const speed of ALTERNATIVES) {
        if (latest.quotes[speed]) continue;
        try {
          const quote = await requestQuote(latest.productId, latest.sellerId, speed, newIdempotencyKey());
          latest = { ...latest, quotes: { ...latest.quotes, [speed]: quote } };
          update(latest);
        } catch {
          setUnavailable((set) => new Set(set).add(speed));
        }
      }
    })();
  }, [ok, ctx, update]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves when the step changes
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepHeading.current?.focus();
  }, [step]);

  if (!ok || !loaded) {
    return (
      <Shell>
        <LoadingBlock label="Loading checkout" />
      </Shell>
    );
  }
  if (!ctx || !ctx.quotes[ctx.speed] || session.status !== "signedIn") {
    return (
      <Shell>
        <EmptyState
          title="This checkout is no longer available"
          description="Quotes last five minutes. Pick the product again to get a fresh price."
          action={
            <Button asChild>
              <a href={ctx ? `/p/${ctx.productId}` : "/"}>
                {ctx ? "Back to the product" : "Back to the shop"}
              </a>
            </Button>
          }
        />
      </Shell>
    );
  }

  const quote = ctx.quotes[ctx.speed] as QuoteResponse;
  const seller = sellerOf(quote, ctx.sellerId);
  if (!seller) return null;
  const total = parsePaise(quote.totalPaise);
  const balance = session.balancePaise;
  const balanceAfter = balance === null ? null : balance - total;
  const card = session.account?.card ?? null;
  const cardAlias = card ? `Delulu Card ending ${card.lastFour}` : "Delulu Card";
  const frozen = card?.status === "FROZEN";
  const cardReason = !card
    ? "You have no card yet."
    : frozen
      ? "Your card is frozen. Unfreeze it under Cards."
      : !card.pinSet
        ? "Set your game PIN first."
        : undefined;
  const effectiveMethod: Method = method === "CARD" && cardReason ? "BALANCE" : method;
  const offered: Speed[] = ["STANDARD", ...ALTERNATIVES.filter((s) => ctx.quotes[s])];

  function begin(message: string) {
    setNotice(null);
    setStatus(message);
  }

  /** A fresh quote for the same product; the old one is dropped. */
  async function requote(speed: Speed, message: string) {
    if (!ctx) return;
    working.current = true;
    setPhase("processing");
    begin("Getting a new price…");
    try {
      const fresh = await requestQuote(ctx.productId, ctx.sellerId, speed, newIdempotencyKey());
      attemptId.current = null;
      payKey.current = null;
      alternativesAsked.current = false;
      update({ ...ctx, quotes: { [speed]: fresh }, speed });
      setStep("review");
      setPhase("idle");
      setStatus("");
      setNotice({ tone: "info", title: "Price updated", text: message });
    } catch (err) {
      setPhase("idle");
      setStatus("");
      handle(err);
    } finally {
      working.current = false;
    }
  }

  function handle(err: unknown) {
    setPhase("idle");
    setStatus("");
    if (!(err instanceof ApiError)) {
      setNotice({ tone: "danger", title: "Something went wrong", text: describeError(err) });
      return;
    }
    const nothingMoved = "No fictional money moved.";
    switch (err.code) {
      case "CART_CHANGED":
      case "PRICE_CHANGED":
        void requote(
          ctx?.speed ?? "STANDARD",
          "The price or stock changed, so we got you a new quote. Check the total.",
        );
        return;
      case "INSUFFICIENT_FUNDS": {
        const short = balance === null ? null : total - balance;
        setNotice({
          tone: "danger",
          title: "Not enough fictional money",
          text:
            short !== null && short > 0n
              ? `This order costs more than your balance. ${nothingMoved}`
              : `Your balance does not cover this order. ${nothingMoved}`,
          link: { href: `/c/${ctx?.category ?? ""}`, label: "Browse cheaper items" },
        });
        return;
      }
      case "ALREADY_OWNED":
        setNotice({
          tone: "warning",
          title: "You already own this",
          text: `Each product can be owned once. ${nothingMoved}`,
          link: { href: "/account/collection", label: "See your collection" },
        });
        return;
      case "CHECKOUT_EXPIRED":
        setNotice({
          tone: "warning",
          title: "This quote expired",
          text: `Quotes last five minutes. ${nothingMoved}`,
          action: {
            label: "Start again with a new price",
            run: () => void requote(ctx?.speed ?? "STANDARD", "Here is your new quote."),
          },
        });
        return;
      case "BUSY":
      case "PAYMENT_PENDING":
        setNotice({
          tone: "warning",
          title: "Still working on it",
          text: "DeluluMart is busy. Your payment is safe to retry: it cannot be charged twice.",
          action: { label: "Try again", run: () => void pay() },
        });
        return;
      case "RATE_LIMITED": {
        const wait =
          typeof err.details.retryAfterSeconds === "number"
            ? ` Wait ${err.details.retryAfterSeconds} seconds.`
            : "";
        setNotice({
          tone: "warning",
          title: "Too many tries",
          text: `${err.message}${wait} ${nothingMoved}`,
        });
        return;
      }
      case "PIN_NOT_SET":
        setNotice({
          tone: "warning",
          title: "Set your game PIN first",
          text: `You need a PIN to pay with the card. ${nothingMoved}`,
          link: { href: "/account/cards", label: "Set your PIN" },
        });
        return;
      case "CARD_FROZEN":
        setNotice({
          tone: "warning",
          title: "Your card is frozen",
          text: `Unfreeze it, or pay from your bank balance. ${nothingMoved}`,
          link: { href: "/account/cards", label: "Open Cards" },
        });
        return;
      case "AUTH_REQUIRED":
        router.replace(`/sign-in?next=${encodeURIComponent(`/checkout/${sessionId}`)}`);
        return;
      default:
        setNotice({
          tone: "danger",
          title: "Payment not completed",
          text: `${err.message} ${nothingMoved}`,
        });
    }
  }

  async function pay() {
    if (working.current || !attemptId.current) return;
    working.current = true;
    setPhase("processing");
    begin("Paying…");
    payKey.current ??= newIdempotencyKey();
    try {
      const receipt = await api<ReceiptResponse>(`/api/v1/checkout-sessions/${quote.id}/pay`, {
        method: "POST",
        idempotencyKey: payKey.current,
        body: { attemptId: attemptId.current },
      });
      setStatus("Payment complete. Opening your order…");
      clearCheckoutContext(sessionId);
      markJustPaid(receipt.orderId);
      void refreshSession();
      router.replace(`/orders/${receipt.orderId}`);
    } catch (err) {
      working.current = false;
      if (!(err instanceof ApiError && (err.code === "BUSY" || err.code === "PAYMENT_PENDING"))) {
        // a definite answer: the next payment is a new intent with a new key
        payKey.current = null;
        attemptId.current = null;
      }
      handle(err);
    }
  }

  async function startPayment() {
    if (working.current) return;
    working.current = true;
    setPhase("processing");
    begin(effectiveMethod === "CARD" ? "Opening the card check…" : "Starting your payment…");
    try {
      const attempt = await api<{ id: string; authenticated: boolean }>(
        `/api/v1/checkout-sessions/${quote.id}/attempts`,
        {
          method: "POST",
          body:
            effectiveMethod === "CARD" && card ? { method: "CARD", cardId: card.id } : { method: "BALANCE" },
        },
      );
      attemptId.current = attempt.id;
      payKey.current = null;
      working.current = false;
      if (attempt.authenticated) {
        await pay();
      } else {
        setPinError(undefined);
        setStatus("");
        setPhase("challenge");
      }
    } catch (err) {
      working.current = false;
      handle(err);
    }
  }

  async function submitPin(pin: string) {
    if (working.current || !attemptId.current) return;
    working.current = true;
    setPinError(undefined);
    setPhase("processing");
    begin("Checking your PIN…");
    try {
      await api(`/api/v1/attempts/${attemptId.current}/pin`, { method: "POST", body: { pin } });
      working.current = false;
      await pay();
    } catch (err) {
      working.current = false;
      if (err instanceof ApiError && err.code === "PIN_INCORRECT") {
        const left = typeof err.details.remainingTries === "number" ? err.details.remainingTries : null;
        setPhase("challenge");
        setStatus("");
        setPinError(
          left === null
            ? "That PIN is not right. No fictional money moved."
            : `That PIN is not right. ${left} ${left === 1 ? "try" : "tries"} left. No fictional money moved.`,
        );
        return;
      }
      if (err instanceof ApiError && err.code === "CHALLENGE_LOCKED") {
        attemptId.current = null;
        setPhase("idle");
        setStatus("");
        setNotice({
          tone: "danger",
          title: "Too many wrong PINs on this payment",
          text: "This payment attempt is locked. No fictional money moved. Start a new attempt to try again.",
        });
        return;
      }
      if (err instanceof ApiError && err.code === "PIN_LOCKED") {
        attemptId.current = null;
        setPhase("idle");
        setStatus("");
        setNotice({
          tone: "danger",
          title: "Your card is locked for a while",
          text: "Too many wrong PINs. No fictional money moved. You can pay from your bank balance, or reset your PIN under Cards.",
          link: { href: "/account/cards", label: "Open Cards" },
        });
        return;
      }
      handle(err);
    }
  }

  function chooseSpeed(speed: Speed) {
    if (ctx) update({ ...ctx, speed });
  }

  const summary = (
    <section
      aria-label="Your item"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={2} size="sm">
        Your item
      </Heading>
      <Text>{ctx.productName}</Text>
      <Text size="sm" muted>
        Sold by DeluluMart Originals · {SPEED_COPY[ctx.speed].name} delivery
      </Text>
    </section>
  );

  return (
    <CheckoutLayout
      header={<SessionHeader />}
      footer={<SiteFooter />}
      steps={
        <div className="flex flex-col gap-3">
          <Heading level={1} size="lg">
            Checkout
          </Heading>
          <CheckoutSteps current={STEP_INDEX[step]} />
        </div>
      }
      summary={summary}
    >
      <div className="flex flex-col gap-4">
        <p role="status" aria-live="polite" className="sr-only">
          {status}
        </p>
        {phase === "processing" ? (
          <div
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4"
            aria-busy="true"
          >
            <Spinner />
            <Text>{status || "Working…"}</Text>
          </div>
        ) : null}
        {notice ? (
          <Alert tone={notice.tone} title={notice.title}>
            <p>{notice.text}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {notice.link ? (
                <a
                  className="inline-flex min-h-touch items-center text-action underline"
                  href={notice.link.href}
                >
                  {notice.link.label}
                </a>
              ) : null}
              {notice.action ? (
                <Button variant="secondary" onClick={notice.action.run}>
                  {notice.action.label}
                </Button>
              ) : null}
            </div>
          </Alert>
        ) : null}

        {phase === "challenge" ? (
          <BankChallenge
            amountPaise={total}
            cardAlias={cardAlias}
            headingLevel={2}
            {...(pinError ? { error: pinError } : {})}
            onPay={(pin) => void submitPin(pin)}
            onCancel={() => {
              attemptId.current = null;
              setPhase("idle");
              setStatus("");
              setNotice(null);
            }}
          />
        ) : null}

        {phase === "idle" && step === "speed" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setNotice(null);
              setStep("payment");
            }}
          >
            <Heading level={2} size="md" tabIndex={-1} ref={stepHeading}>
              Delivery speed
            </Heading>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Delivery speed</legend>
              {offered.map((speed) => {
                const q = ctx.quotes[speed];
                const entry = q ? sellerOf(q, ctx.sellerId) : undefined;
                return (
                  <DeliveryOption
                    key={speed}
                    name="speed"
                    value={speed}
                    checked={ctx.speed === speed}
                    onChange={() => chooseSpeed(speed)}
                    speedName={SPEED_COPY[speed].name}
                    arrival={SPEED_COPY[speed].arrival}
                    feePaise={entry ? parsePaise(entry.deliveryFeePaise) : 0n}
                  />
                );
              })}
            </fieldset>
            {unavailable.size > 0 ? (
              <Text size="sm" muted>
                Express and Zap are only offered for some items.
              </Text>
            ) : null}
            <Button type="submit" size="lg">
              Continue to payment
            </Button>
          </form>
        ) : null}

        {phase === "idle" && step === "payment" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setNotice(null);
              setStep("review");
            }}
          >
            <Heading level={2} size="md" tabIndex={-1} ref={stepHeading}>
              Payment method
            </Heading>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Payment method</legend>
              <PaymentMethodOption
                name="method"
                value="CARD"
                checked={effectiveMethod === "CARD"}
                onChange={() => setMethod("CARD")}
                methodName="Delulu Card"
                description={
                  card
                    ? `Ends in ${card.lastFour}. You will enter your game PIN.`
                    : "Pay with your virtual card."
                }
                {...(cardReason ? { disabledReason: cardReason } : {})}
              />
              <PaymentMethodOption
                name="method"
                value="BALANCE"
                checked={effectiveMethod === "BALANCE"}
                onChange={() => setMethod("BALANCE")}
                methodName="Bank balance"
                description="Pay straight from your Delulu Bank balance."
              />
            </fieldset>
            {cardReason && card && !card.pinSet ? (
              <a className="inline-flex min-h-touch items-center text-action underline" href="/account/cards">
                Set your game PIN
              </a>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => setStep("speed")}>
                Back
              </Button>
              <Button type="submit" size="lg" className="flex-1">
                Review your order
              </Button>
            </div>
          </form>
        ) : null}

        {phase === "idle" && step === "review" ? (
          <div className="flex flex-col gap-4">
            <Heading level={2} size="md" tabIndex={-1} ref={stepHeading}>
              Review your order
            </Heading>
            <OrderSummary
              itemsTotalPaise={parsePaise(seller.listPaise)}
              discountPaise={
                parsePaise(seller.sellerDiscountPaise) + parsePaise(seller.platformDiscountPaise)
              }
              deliveryFeePaise={parsePaise(seller.deliveryFeePaise)}
              totalPaise={total}
            />
            <dl className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 text-base">
              <div className="flex justify-between gap-3">
                <dt className="text-fg-muted">Item</dt>
                <dd className="text-right text-fg">{ctx.productName}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-fg-muted">Delivery</dt>
                <dd className="text-fg">{SPEED_COPY[ctx.speed].name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-fg-muted">Pay with</dt>
                <dd className="text-fg">{effectiveMethod === "CARD" ? cardAlias : "Bank balance"}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
                <dt className="text-fg-muted">Balance after</dt>
                <dd>
                  {balanceAfter !== null ? (
                    balanceAfter >= 0n ? (
                      <Price amountPaise={balanceAfter} display="exact" />
                    ) : (
                      <span className="font-semibold text-danger">Not enough balance</span>
                    )
                  ) : (
                    "Not available"
                  )}
                </dd>
              </div>
            </dl>
            <FictionLabel>Fictional money. No real card or bank details are used.</FictionLabel>
            {balanceAfter !== null && balanceAfter < 0n ? (
              <Alert tone="danger" title="This costs more than your balance">
                Pick something cheaper.{" "}
                <a className="text-action underline" href={`/c/${ctx.category}`}>
                  Browse cheaper items
                </a>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => setStep("payment")}>
                Back
              </Button>
              <Button type="button" size="lg" className="flex-1" onClick={() => void startPayment()}>
                Pay now
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </CheckoutLayout>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <CheckoutLayout
      header={<SessionHeader />}
      footer={<SiteFooter />}
      steps={
        <Heading level={1} size="lg">
          Checkout
        </Heading>
      }
      summary={null}
    >
      {children}
    </CheckoutLayout>
  );
}
