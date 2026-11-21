"use client";

import {
  Alert,
  Badge,
  Button,
  DecisionForm,
  EmptyState,
  FormField,
  Heading,
  Input,
  ModerationReviewCard,
  Price,
  ProductCard,
  Switch,
  Text,
  Textarea,
} from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../../_lib/api";
import { type AppealQueueItem, reasonLabel } from "../../_lib/merchant";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import {
  categoryLabel,
  type ModerationItem,
  type ModerationPage,
  reasonLines,
  studioErrorText,
} from "../../_lib/studio";
import { PageHeading } from "../PageHeading";
import { type ConsoleAccess, ConsoleFrame, ConsoleGate, isDenied } from "./ConsoleFrame";

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
  const [access, setAccess] = useState<ConsoleAccess>("checking");
  const [items, setItems] = useState<ModerationItem[]>([]);
  const [appeals, setAppeals] = useState<AppealQueueItem[]>([]);
  const [message, setMessage] = useState("");

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const all: ModerationItem[] = [];
      const queue = new Map<string, AppealQueueItem>();
      let cursor: string | null = null;
      do {
        const page: ModerationPage = await api<ModerationPage>(
          `/api/v1/admin/moderation?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        );
        all.push(...page.items);
        for (const a of page.appeals as AppealQueueItem[]) queue.set(a.appealId, a);
        cursor = page.nextCursor;
      } while (cursor);
      setItems(all);
      setAppeals([...queue.values()]);
      setAccess("allowed");
      return true;
    } catch (error) {
      if (isDenied(error)) {
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

  if (access !== "allowed")
    return <ConsoleGate access={access} message={message} onRetry={() => void load()} />;

  return (
    <ConsoleFrame current="/console/moderation">
      <ModerationBody
        items={items}
        appeals={appeals}
        reload={load}
        announce={(text) => setMessage(text)}
        message={message}
      />
    </ConsoleFrame>
  );
}

function ModerationBody({
  items,
  appeals,
  reload,
  announce,
  message,
}: {
  items: ModerationItem[];
  appeals: AppealQueueItem[];
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

      <AppealsSection appeals={appeals} reload={reload} say={say} />

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

const KIND_LABEL = { REJECTION: "Rejected first submission", HIDE: "Hidden listing" } as const;

function AppealsSection({
  appeals,
  reload,
  say,
}: {
  appeals: AppealQueueItem[];
  reload: () => Promise<boolean>;
  say: (n: Notice) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function resolve(a: AppealQueueItem, outcome: "UPHELD" | "DENIED", reason: string) {
    setBusyId(a.appealId);
    setErrors((e) => ({ ...e, [a.appealId]: "" }));
    try {
      await api(`/api/v1/admin/appeals/${a.appealId}/resolve`, { method: "POST", body: { outcome, reason } });
      say({
        tone: "success",
        text: `${outcome === "UPHELD" ? "Appeal upheld" : "Appeal denied"}: ${a.version?.name ?? a.store.displayName}.`,
      });
      await reload();
    } catch (error) {
      setErrors((e) => ({ ...e, [a.appealId]: studioErrorText(error) }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="appeals-heading" className="flex flex-col gap-3">
      <Heading level={2} size="sm" id="appeals-heading">
        Appeals ({appeals.length})
      </Heading>
      <Text size="sm" muted>
        Oldest first. Upholding restores the listing; denying leaves the decision as it was.
      </Text>
      {appeals.length === 0 ? (
        <EmptyState
          title="No open appeals"
          description="Appeals from sellers appear here."
          headingLevel={3}
        />
      ) : (
        <ul aria-label="Open appeals" className="flex flex-col gap-4">
          {appeals.map((a) => {
            const name = a.version?.name ?? "Listing";
            const reasons = reasonLines(a.evidence.reasons);
            const reports = a.evidence.reports;
            return (
              <li key={a.appealId}>
                <article
                  aria-label={`Appeal: ${name}`}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Heading level={3} size="sm" className="break-words">
                      {name}
                    </Heading>
                    <Badge tone="info">{KIND_LABEL[a.kind]}</Badge>
                  </div>
                  <p className="text-sm text-fg-muted">
                    From {a.store.displayName} (/store/{a.store.handle}) · sent {formatWhen(a.createdAt)} ·
                    listing is now {a.productStatus.toLowerCase().replaceAll("_", " ")}
                  </p>
                  <div>
                    <p className="text-sm font-bold">The seller says</p>
                    <p className="whitespace-pre-wrap break-words text-sm">{a.statement}</p>
                  </div>
                  <div>
                    <p className="text-sm font-bold">Original decision</p>
                    {a.decision ? (
                      <p className="break-words text-sm">
                        {a.decision.action.toLowerCase().replaceAll("_", " ")}
                        {a.decision.by ? ` by ${a.decision.by}` : ""}
                        {a.decision.at ? `, ${formatWhen(a.decision.at)}` : ""}. Reason:{" "}
                        {a.decision.reason ?? "none recorded"}
                      </p>
                    ) : (
                      <p className="text-sm">No decision recorded.</p>
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-bold">Evidence</p>
                    {reasons.length === 0 && !reports ? <p className="text-sm">None recorded.</p> : null}
                    {reasons.length > 0 ? (
                      <ul aria-label="Screening reasons" className="list-disc pl-5 text-sm">
                        {reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    ) : null}
                    {reports ? (
                      <p className="text-sm">
                        Report case with {reports.reporterCount}{" "}
                        {reports.reporterCount === 1 ? "reporter" : "reporters"}:{" "}
                        {Object.entries(reports.reasonCounts)
                          .map(([r, n]) => `${reasonLabel(r)} (${n})`)
                          .join(", ")}
                        .
                      </p>
                    ) : null}
                  </div>
                  <DecisionForm
                    label={`appeal for ${name}`}
                    hint="The seller will see this."
                    options={[
                      { value: "UPHELD", label: "Uphold" },
                      { value: "DENIED", label: "Deny", variant: "danger" },
                    ]}
                    busy={busyId === a.appealId}
                    error={errors[a.appealId] || null}
                    onDecide={(outcome, reason) => void resolve(a, outcome, reason)}
                  />
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
