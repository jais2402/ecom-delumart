"use client";

import {
  Alert,
  BankChallenge,
  Button,
  EmptyState,
  FictionLabel,
  Heading,
  PaymentMethodOption,
  Price,
  RegistrationReview,
  ShopIdentityForm,
  type ShopIdentityValues,
  Spinner,
  Text,
  WarehouseUsage,
} from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, describeError, newIdempotencyKey } from "../../_lib/api";
import { parsePaise, parsePaiseOrNull } from "../../_lib/money";
import {
  type CompanyQuoteResponse,
  type CompanyReceiptResponse,
  type CompanyView,
  type CreatorAccessResponse,
  LISTING_HREF,
  reasonsByField,
  SHOP_LIMITS,
  sellingErrorText,
} from "../../_lib/selling";
import { refreshSession } from "../../_lib/session-store";
import { useApiGet } from "../../_lib/use-api";
import { useRequireAccount } from "../../_lib/use-require-account";
import { LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

type Phase = "form" | "review" | "challenge" | "processing" | "done";
type Method = "CARD" | "BALANCE";
type FieldErrors = Partial<Record<keyof ShopIdentityValues, string[]>>;

interface Notice {
  tone: "danger" | "warning" | "info";
  title: string;
  text: string;
  link?: { href: string; label: string };
  action?: { label: string; run: () => void };
}

const EMPTY: ShopIdentityValues = { handle: "", displayName: "", description: "" };

/** /sell/register: details, a quote, payment (Delulu Card with PIN, or bank balance), confirmation. */
export function RegisterFlow() {
  const router = useRouter();
  const { session, ok } = useRequireAccount();
  const access = useApiGet<CreatorAccessResponse>(ok ? "/api/v1/creator-access" : null);
  const existing = useApiGet<{ company: CompanyView | null }>(ok ? "/api/v1/company" : null);

  const [phase, setPhase] = useState<Phase>("form");
  const [values, setValues] = useState<ShopIdentityValues>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [quote, setQuote] = useState<CompanyQuoteResponse | null>(null);
  const [expired, setExpired] = useState(false);
  const [method, setMethod] = useState<Method>("CARD");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pinError, setPinError] = useState<string | undefined>();
  const [receipt, setReceipt] = useState<CompanyReceiptResponse | null>(null);
  const [company, setCompany] = useState<CompanyView | null>(null);
  const attemptId = useRef<string | null>(null);
  const registerKey = useRef<string | null>(null);
  const working = useRef(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);

  useEffect(() => {
    if (access.status === "ready" && !access.data.unlocked) router.replace("/sell");
  }, [access, router]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves when the step changes
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepHeading.current?.focus();
  }, [phase]);

  if (
    !ok ||
    access.status === "loading" ||
    existing.status === "loading" ||
    (access.status === "ready" && !access.data.unlocked)
  ) {
    return (
      <Page>
        <LoadingBlock label="Loading" />
      </Page>
    );
  }
  if (access.status === "error" || existing.status === "error" || session.status !== "signedIn") {
    return (
      <Page>
        <Alert tone="danger" title="That did not load">
          {access.status === "error"
            ? access.message
            : existing.status === "error"
              ? existing.message
              : "Sign in again."}
        </Alert>
      </Page>
    );
  }
  if (phase !== "done" && existing.data.company) {
    return (
      <Page>
        <EmptyState
          title="You already have a shop"
          description={`${existing.data.company.displayName} is open. Each person can register one shop.`}
          action={
            <Button asChild>
              <a href="/sell/shop">Open your shop</a>
            </Button>
          }
        />
      </Page>
    );
  }

  const balance = session.balancePaise;
  const card = session.account?.card ?? null;
  const cardReason = !card
    ? "You have no card yet."
    : card.status === "FROZEN"
      ? "Your card is frozen. Unfreeze it under Cards."
      : !card.pinSet
        ? "Set your game PIN first."
        : undefined;
  const effectiveMethod: Method = method === "CARD" && cardReason ? "BALANCE" : method;
  const cardAlias = card ? `Delulu Card ending ${card.lastFour}` : "Delulu Card";

  function begin(message: string) {
    setNotice(null);
    setStatus(message);
  }

  function goBackToForm(errors: FieldErrors) {
    attemptId.current = null;
    registerKey.current = null;
    setFieldErrors(errors);
    setQuote(null);
    setPhase("form");
    setBusy(false);
    setStatus("");
  }

  function fail(err: unknown) {
    working.current = false;
    setBusy(false);
    setStatus("");
    setPhase((current) => (current === "processing" ? "review" : current));
    if (!(err instanceof ApiError)) {
      setNotice({ tone: "danger", title: "Something went wrong", text: describeError(err) });
      return;
    }
    const nothing = "No fictional money moved.";
    switch (err.code) {
      case "VALIDATION_FAILED": {
        const reasons = reasonsByField(err);
        goBackToForm({
          handle: reasons.handle ?? [],
          displayName: reasons.displayName ?? [],
          description: reasons.description ?? [],
        });
        return;
      }
      case "HANDLE_TAKEN":
      case "HANDLE_RESERVED":
        goBackToForm({ handle: [sellingErrorText(err)] });
        return;
      case "COMPANY_EXISTS":
        setNotice({
          tone: "info",
          title: "You already have a shop",
          text: "Each person can register one shop.",
          link: { href: "/sell/shop", label: "Open your shop" },
        });
        return;
      case "CREATOR_LOCKED":
        router.replace("/sell");
        return;
      case "ONBOARDING_REQUIRED":
        setNotice({
          tone: "warning",
          title: "Finish setting up your account",
          text: sellingErrorText(err),
          link: { href: "/account", label: "Go to your account" },
        });
        return;
      case "CHECKOUT_EXPIRED":
        attemptId.current = null;
        registerKey.current = null;
        setExpired(true);
        setPhase("review");
        return;
      case "INSUFFICIENT_FUNDS":
        setNotice({
          tone: "danger",
          title: "Not enough fictional money",
          text: `${sellingErrorText(err)} ${nothing}`,
        });
        return;
      case "BUSY":
      case "PAYMENT_PENDING":
        setNotice({
          tone: "warning",
          title: "Still working on it",
          text: "DeluluMart is busy. Trying again is safe: you cannot be charged twice.",
          action: { label: "Try again", run: () => void register() },
        });
        return;
      case "RATE_LIMITED":
        setNotice({ tone: "warning", title: "Too many tries", text: `${sellingErrorText(err)} ${nothing}` });
        return;
      case "PIN_NOT_SET":
        setNotice({
          tone: "warning",
          title: "Set your game PIN first",
          text: `You need a PIN to pay with the card. ${nothing}`,
          link: { href: "/account/cards", label: "Set your PIN" },
        });
        return;
      case "CARD_FROZEN":
        setNotice({
          tone: "warning",
          title: "Your card is frozen",
          text: `Unfreeze it, or pay from your bank balance. ${nothing}`,
          link: { href: "/account/cards", label: "Open Cards" },
        });
        return;
      case "AUTH_REQUIRED":
        router.replace("/sign-in?next=%2Fsell%2Fregister");
        return;
      default:
        setNotice({ tone: "danger", title: "Registration not completed", text: `${err.message} ${nothing}` });
    }
  }

  async function requestQuote(next: ShopIdentityValues) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setNotice(null);
    setFieldErrors({});
    try {
      const fresh = await api<CompanyQuoteResponse>("/api/v1/company/quote", { method: "POST", body: next });
      setValues(next);
      setQuote(fresh);
      setExpired(false);
      attemptId.current = null;
      registerKey.current = null;
      setPhase("review");
    } catch (err) {
      fail(err);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function register() {
    if (!quote || !attemptId.current || working.current) return;
    working.current = true;
    setPhase("processing");
    begin("Registering your shop…");
    registerKey.current ??= newIdempotencyKey();
    try {
      const done = await api<CompanyReceiptResponse>("/api/v1/company/register", {
        method: "POST",
        idempotencyKey: registerKey.current,
        body: { sessionId: quote.sessionId, attemptId: attemptId.current },
      });
      working.current = false;
      setReceipt(done);
      setPhase("done");
      setStatus("");
      void refreshSession();
      try {
        const mine = await api<{ company: CompanyView | null }>("/api/v1/company");
        setCompany(mine.company);
      } catch {
        // the confirmation stands without the warehouse line
      }
    } catch (err) {
      if (!(err instanceof ApiError && (err.code === "BUSY" || err.code === "PAYMENT_PENDING"))) {
        registerKey.current = null;
        attemptId.current = null;
      }
      fail(err);
    }
  }

  async function startPayment() {
    if (!quote || working.current) return;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setExpired(true);
      return;
    }
    working.current = true;
    setPhase("processing");
    begin(effectiveMethod === "CARD" ? "Opening the card check…" : "Starting your payment…");
    try {
      const attempt = await api<{ id: string; authenticated: boolean }>(
        `/api/v1/checkout-sessions/${quote.sessionId}/attempts`,
        {
          method: "POST",
          body:
            effectiveMethod === "CARD" && card ? { method: "CARD", cardId: card.id } : { method: "BALANCE" },
        },
      );
      attemptId.current = attempt.id;
      registerKey.current = null;
      working.current = false;
      if (attempt.authenticated) {
        await register();
      } else {
        setPinError(undefined);
        setStatus("");
        setPhase("challenge");
      }
    } catch (err) {
      fail(err);
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
      await register();
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
      if (err instanceof ApiError && (err.code === "CHALLENGE_LOCKED" || err.code === "PIN_LOCKED")) {
        attemptId.current = null;
        setPhase("review");
        setStatus("");
        setNotice({
          tone: "danger",
          title:
            err.code === "PIN_LOCKED"
              ? "Your card is locked for a while"
              : "Too many wrong PINs on this payment",
          text: "No fictional money moved. You can pay from your bank balance instead.",
          link: { href: "/account/cards", label: "Open Cards" },
        });
        return;
      }
      fail(err);
    }
  }

  const noticeBlock = notice ? (
    <Alert tone={notice.tone} title={notice.title}>
      <p>{notice.text}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {notice.link ? (
          <a className="inline-flex min-h-touch items-center text-action underline" href={notice.link.href}>
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
  ) : null;

  const live = (
    <p role="status" aria-live="polite" className="sr-only">
      {status}
    </p>
  );

  if (phase === "done" && receipt) {
    const starter = company?.warehouses.starter ?? null;
    const paid = parsePaise(receipt.paidPaise);
    const sponsored = parsePaise(receipt.sponsorshipPaise);
    const after = parsePaiseOrNull(receipt.balanceAfterPaise);
    return (
      <Page title="Your shop is open" headingRef={stepHeading}>
        <section aria-label="Registration confirmation" className="flex flex-col gap-4">
          <Heading level={2} size="md">
            {receipt.displayName}
          </Heading>
          <Text className="break-all font-mono">/store/{receipt.handle}</Text>
          {starter ? (
            <WarehouseUsage used={starter.used} capacity={starter.capacity} />
          ) : (
            <Text size="sm" muted>
              Your starter warehouse is ready.
            </Text>
          )}
          <p className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 text-base">
            <span>
              Receipt: setup fee <Price amountPaise={parsePaise(receipt.feePaise)} display="exact" />
              {sponsored > 0n ? (
                <>
                  , covered for you <Price amountPaise={sponsored} display="exact" />
                </>
              ) : null}
              , paid <Price amountPaise={paid} display="exact" />.
            </span>
            <span className="text-sm text-fg-muted">
              Payment reference <span className="font-mono">{receipt.paymentReference}</span>
              {after !== null ? (
                <>
                  {" "}
                  · Balance now <Price amountPaise={after} display="exact" className="text-sm" />
                </>
              ) : null}
            </span>
          </p>
          <FictionLabel>Fictional money. This was a one-time setup fee, not a product purchase.</FictionLabel>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="lg">
              <a href={LISTING_HREF}>Create your first listing</a>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <a href={`/store/${receipt.handle}`}>View your shop page</a>
            </Button>
            <Button asChild variant="ghost" size="lg">
              <a href="/sell/shop">Shop home</a>
            </Button>
          </div>
        </section>
      </Page>
    );
  }

  return (
    <Page>
      {live}
      {phase === "processing" ? (
        <div
          className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4"
          aria-busy="true"
        >
          <Spinner />
          <Text>{status || "Working…"}</Text>
        </div>
      ) : null}
      {noticeBlock}

      {phase === "form" ? (
        <section aria-labelledby="shop-details" className="flex flex-col gap-3">
          <Heading level={2} size="md" id="shop-details" tabIndex={-1} ref={stepHeading}>
            Shop details
          </Heading>
          <ShopIdentityForm
            initial={values}
            limits={SHOP_LIMITS}
            fieldErrors={fieldErrors}
            loading={busy}
            submitLabel="Review the fee"
            onSubmit={(next) => void requestQuote(next)}
          />
        </section>
      ) : null}

      {phase === "challenge" && quote ? (
        <BankChallenge
          amountPaise={parsePaise(quote.payablePaise)}
          cardAlias={cardAlias}
          headingLevel={2}
          {...(pinError ? { error: pinError } : {})}
          onPay={(pin) => void submitPin(pin)}
          onCancel={() => {
            attemptId.current = null;
            setPhase("review");
            setStatus("");
            setNotice(null);
          }}
        />
      ) : null}

      {phase === "review" && quote ? (
        <RegistrationReview
          displayName={quote.displayName}
          handle={quote.handle}
          feePaise={parsePaise(quote.feePaise)}
          sponsorshipPaise={parsePaise(quote.sponsorshipPaise)}
          payablePaise={parsePaise(quote.payablePaise)}
          balanceAfterPaise={parsePaiseOrNull(quote.balanceAfterPaise)}
          sufficient={quote.sufficient}
          expired={expired}
          refreshing={busy}
          onRefresh={() => void requestQuote(values)}
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void startPayment();
            }}
          >
            <Heading level={3} size="sm" tabIndex={-1} ref={stepHeading}>
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
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => setPhase("form")}>
                Change details
              </Button>
              <Button
                type="submit"
                size="lg"
                className="flex-1"
                disabled={!quote.sufficient || (balance !== null && balance < parsePaise(quote.payablePaise))}
              >
                Pay the setup fee
              </Button>
            </div>
          </form>
        </RegistrationReview>
      ) : null}
    </Page>
  );
}

function Page({
  children,
  title = "Register your shop",
  headingRef,
}: {
  children: React.ReactNode;
  title?: string;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="flex flex-col gap-6">
      {headingRef ? (
        <Heading level={1} size="lg" tabIndex={-1} ref={headingRef} className="outline-none">
          {title}
        </Heading>
      ) : (
        <PageHeading>{title}</PageHeading>
      )}
      {children}
    </div>
  );
}
