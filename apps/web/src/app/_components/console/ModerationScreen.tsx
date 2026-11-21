"use client";

import {
  Alert,
  Badge,
  Button,
  ConsoleLayout,
  EmptyState,
  FormField,
  Heading,
  Input,
  ModerationReviewCard,
  Price,
  ProductCard,
  SidebarNav,
  Switch,
  Text,
  Textarea,
} from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import {
  categoryLabel,
  isForbidden,
  type ModerationItem,
  type ModerationPage,
  reasonLines,
  studioErrorText,
} from "../../_lib/studio";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";
import { ShopShell } from "../ShopShell";

type Access = "checking" | "denied" | "allowed" | "error";
type Notice = { tone: "success" | "danger" | "info"; text: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonProblem = (text: string): string | null => {
  const n = [...text.trim()].length;
  if (n < 5) return "Give a reason of at least 5 characters.";
  if (n > 500) return "Use 500 characters or fewer.";
  return null;
};

/**
 * /console/moderation. The admin route decides who may be here: anyone it refuses (or anyone
 * signed out) gets a plain "Not available" page that says nothing about what exists.
 */
export function ModerationScreen() {
  const [access, setAccess] = useState<Access>("checking");
  const [items, setItems] = useState<ModerationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const all: ModerationItem[] = [];
      let cursor: string | null = null;
      do {
        const page: ModerationPage = await api<ModerationPage>(
          `/api/v1/admin/moderation?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      setItems(all);
      setNextCursor(null);
      setAccess("allowed");
      return true;
    } catch (error) {
      if (isForbidden(error) || (error instanceof ApiError && error.code === "AUTH_REQUIRED")) {
        setAccess("denied");
      } else {
        setMessage(studioErrorText(error));
        setAccess("error");
      }
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (access === "checking") {
    return (
      <ShopShell>
        <LoadingBlock rows={2} label="Loading" />
      </ShopShell>
    );
  }
  if (access === "denied") {
    return (
      <ShopShell>
        <div className="flex flex-col gap-3">
          <PageHeading>Not available</PageHeading>
          <Text muted>This page is not available.</Text>
          <Button asChild className="self-start">
            <a href="/">Go to the shop</a>
          </Button>
        </div>
      </ShopShell>
    );
  }
  if (access === "error") {
    return (
      <ShopShell>
        <PageHeading>Something went wrong</PageHeading>
        <ErrorBlock message={message} onRetry={() => void load()} />
      </ShopShell>
    );
  }

  return (
    <ConsoleLayout
      nav={
        <SidebarNav
          label="Commerce Console"
          currentHref="/console/moderation"
          items={[
            { label: "Moderation", href: "/console/moderation" },
            { label: "Back to the shop", href: "/" },
          ]}
        />
      }
      topBar={<Badge tone="highlight">Super Admin</Badge>}
    >
      <ModerationBody
        items={items}
        hasMore={nextCursor !== null}
        reload={load}
        announce={(text) => setMessage(text)}
        message={message}
      />
    </ConsoleLayout>
  );
}

function ModerationBody({
  items,
  reload,
  announce,
  message,
}: {
  items: ModerationItem[];
  hasMore: boolean;
  reload: () => Promise<boolean>;
  announce: (text: string) => void;
  message: string;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [paused, setPaused] = useState<boolean | null>(null);

  function say(next: Notice) {
    setNotice(next);
    announce(next.text);
  }

  async function decide(item: ModerationItem, decision: "APPROVE" | "REJECT", reason: string) {
    setBusyId(item.submissionId);
    setErrors((e) => ({ ...e, [item.submissionId]: "" }));
    try {
      await api(`/api/v1/admin/listings/${item.productId}/decision`, {
        method: "POST",
        body: { versionId: item.versionId, decision, reason },
      });
      say({
        tone: "success",
        text: `${decision === "APPROVE" ? "Approved" : "Rejected"}: ${item.version.name}. The queue is updated.`,
      });
      await reload();
    } catch (error) {
      if (error instanceof ApiError && error.code === "PUBLICATION_PAUSED") setPaused(true);
      setErrors((e) => ({ ...e, [item.submissionId]: studioErrorText(error) }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Moderation</PageHeading>
      <span role="status" aria-live="polite" className="sr-only">
        {message}
      </span>
      {paused === true ? (
        <Alert tone="warning" title="Publishing is paused">
          Nothing new goes live, and approvals are refused, until you resume publishing below.
        </Alert>
      ) : null}
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      <section aria-labelledby="queue-heading" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="queue-heading">
          Waiting for review ({items.length})
        </Heading>
        <Text size="sm" muted>
          Oldest first.
        </Text>
        {items.length === 0 ? (
          <EmptyState
            title="Nothing waiting"
            description="New submissions that need a person appear here."
            headingLevel={3}
          />
        ) : (
          <ul aria-label="Review queue" className="flex flex-col gap-4">
            {items.map((item) => (
              <li key={item.submissionId}>
                <ModerationReviewCard
                  storeName={item.store.displayName}
                  storeHandle={item.store.handle}
                  kindLabel={item.kind === "REVISION" ? "Revision" : "First submission"}
                  submittedAt={formatWhen(item.submittedAt)}
                  fields={{
                    name: item.version.name,
                    hook: item.version.hook,
                    description: item.version.description,
                    altText: item.version.altText,
                    category: categoryLabel(item.category),
                    mode: item.inventoryMode === "EXCLUSIVE" ? "Exclusive edition" : "Standard",
                    price: (
                      <Price
                        amountPaise={parsePaise(item.version.pricePaise)}
                        display="exact"
                        className="text-sm"
                      />
                    ),
                  }}
                  reasons={reasonLines(item.reasons)}
                  preview={
                    <div inert>
                      <ProductCard
                        href="#preview"
                        name={item.version.name}
                        hook={item.version.hook ?? ""}
                        hue={item.version.templateId}
                        imageAlt={item.version.altText}
                        pricePaise={parsePaise(item.version.pricePaise)}
                        storeName={item.store.displayName}
                        headingLevel={4}
                      />
                    </div>
                  }
                  busy={busyId === item.submissionId}
                  error={errors[item.submissionId] || null}
                  onDecide={(decision, reason) => void decide(item, decision, reason)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <HideRestore say={say} />
      <PauseSwitch paused={paused} setPaused={setPaused} say={say} />
    </div>
  );
}

function HideRestore({ say }: { say: (n: Notice) => void }) {
  const [productId, setProductId] = useState("");
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idProblem = UUID.test(productId.trim())
    ? null
    : "Enter the product id (it looks like 1b4e28ba-2fa1-…).";
  const rProblem = reasonProblem(reason);

  async function act(kind: "hide" | "restore") {
    setShown(true);
    if (idProblem || rProblem) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/admin/listings/${productId.trim().toLowerCase()}/${kind}`, {
        method: "POST",
        body: { reason: reason.trim() },
      });
      say({
        tone: "success",
        text:
          kind === "hide"
            ? "Hidden. It is off the shop and the catalog."
            : "Restored. It is back on the shop.",
      });
      setReason("");
      setShown(false);
    } catch (e) {
      setError(studioErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="hide-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={2} size="sm" id="hide-heading">
        Hide a live listing
      </Heading>
      <Text size="sm" muted>
        Hiding takes a published listing off the shop and out of the catalog. Restore puts it back.
      </Text>
      <FormField label="Product id" required error={shown ? idProblem : null}>
        {(control) => (
          <Input
            {...control}
            autoComplete="off"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Reason for hide or restore"
        required
        hint="5 to 500 characters."
        error={shown ? rProblem : null}
      >
        {(control) => (
          <Textarea {...control} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </FormField>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" disabled={busy} onClick={() => void act("hide")}>
          Hide listing
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void act("restore")}>
          Restore listing
        </Button>
      </div>
    </section>
  );
}

/** The API cannot say whether publishing is paused, so the switch shows what this page has learned. */
function PauseSwitch({
  paused,
  setPaused,
  say,
}: {
  paused: boolean | null;
  setPaused: (paused: boolean) => void;
  say: (n: Notice) => void;
}) {
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = reasonProblem(reason);

  async function flip(pause: boolean) {
    setShown(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/admin/switches/publication", {
        method: "POST",
        body: { enabled: !pause, reason: reason.trim() },
      });
      setPaused(pause);
      setReason("");
      setShown(false);
      say({
        tone: pause ? "info" : "success",
        text: pause ? "Publishing is paused for everyone." : "Publishing is back on.",
      });
    } catch (e) {
      setError(studioErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="pause-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={2} size="sm" id="pause-heading">
        Pause all publishing
      </Heading>
      <div className="flex items-center gap-3">
        <Switch
          aria-label="Pause all publishing"
          checked={paused === true}
          disabled={busy}
          onCheckedChange={(on) => void flip(on)}
        />
        <Text size="sm">
          {paused === null
            ? "Publishing status is shown once you change it, or when an approval is refused."
            : paused
              ? "Publishing is paused."
              : "Publishing is on."}
        </Text>
      </div>
      <FormField
        label="Reason for the change"
        required
        hint="5 to 500 characters. Fill this in, then use the switch."
        error={shown ? problem : null}
      >
        {(control) => (
          <Textarea {...control} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </FormField>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </section>
  );
}
