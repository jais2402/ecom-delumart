"use client";

import {
  Alert,
  Button,
  FormField,
  Heading,
  Input,
  type ListingField,
  ListingForm,
  type ListingFormMode,
  type ListingFormValues,
  ListingStatus,
  Text,
} from "@delulu/ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../../_lib/api";
import type { CompanyView } from "../../_lib/selling";
import {
  CATEGORY_OPTIONS,
  draftBody,
  EMPTY_VALUES,
  type ListingDetail,
  listingFieldErrors,
  reasonLines,
  revisionBody,
  studioErrorText,
  valuesFromListing,
} from "../../_lib/studio";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";
import { ConfirmDialog } from "./ConfirmDialog";
import { ListingPreview } from "./ListingPreview";
import { PublishedActions } from "./PublishedActions";
import { useStudioCompany } from "./StudioShell";

type Notice = { tone: "success" | "danger" | "info" | "warning"; text: string };

const POLL_EVERY_MS = 2_000;
const POLL_MAX = 10; // 20 seconds

const screening = (l: ListingDetail) => l.status === "SCREENING" || l.pending?.state === "SCREENING";

function modeOf(l: ListingDetail | null): { mode: ListingFormMode; reason?: string } {
  if (l === null) return { mode: "draft" };
  if (l.approvedNeedsStock && l.status === "DRAFT")
    return { mode: "locked", reason: "This listing is approved. Add stock below to publish it." };
  switch (l.status) {
    case "DRAFT":
    case "REJECTED":
      return { mode: "draft" };
    case "SCREENING":
      return {
        mode: "locked",
        reason: "Being checked — usually quick. You can edit again if it is not approved.",
      };
    case "NEEDS_REVIEW":
      return {
        mode: "locked",
        reason: "Waiting for a person to review. Editing is paused until they decide.",
      };
    case "PUBLISHED":
      return l.pending
        ? {
            mode: "locked",
            reason:
              "Your revision is waiting for review. The current version stays live until it is approved.",
          }
        : { mode: "revise" };
    case "HIDDEN":
      return { mode: "locked", reason: "This listing was hidden by DeluluMart, so it cannot be edited." };
    case "ARCHIVED":
      return { mode: "locked", reason: "This listing is archived and cannot be edited." };
  }
}

function outcomeText(p: ListingDetail): string {
  if (p.status === "PUBLISHED") return "Your listing passed the check and is published.";
  if (p.status === "NEEDS_REVIEW")
    return "Your listing needs a person to review it. You will see the result here.";
  if (p.status === "REJECTED") return "Your listing was not approved. See what to change below.";
  if (p.approvedNeedsStock) return "Your listing is approved. Add stock to publish it.";
  return "Your listing was checked.";
}

/** /studio/new and /studio/[id]: the editor, its live preview, review status and the actions that fit the status. */
export function ListingEditor({ productId }: { productId: string | null }) {
  const company = useStudioCompany();
  const [id, setId] = useState<string | null>(productId);
  const loaded = useApiGet<{ product: ListingDetail }>(
    productId ? `/api/v1/studio/products/${productId}` : null,
  );
  const companyNow = useApiGet<{ company: CompanyView | null }>("/api/v1/company");
  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [values, setValues] = useState<ListingFormValues>(EMPTY_VALUES);
  const [initialised, setInitialised] = useState(productId === null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ListingField, string[]>>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [announce, setAnnounce] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [polling, setPolling] = useState(false);
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    if (loaded.status === "ready" && !initialised) {
      setListing(loaded.data.product);
      setValues(valuesFromListing(loaded.data.product));
      setInitialised(true);
    }
  }, [loaded, initialised]);

  // After a submission: look again every 2 seconds, for up to 20, until screening is over.
  useEffect(() => {
    if (!polling || id === null) return;
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      api<{ product: ListingDetail }>(`/api/v1/studio/products/${id}`)
        .then(({ product }) => {
          if (cancelled) return;
          setListing(product);
          if (!screening(product)) {
            setPolling(false);
            setAnnounce(outcomeText(product));
            setNotice({
              tone: product.status === "REJECTED" ? "warning" : "success",
              text: outcomeText(product),
            });
          } else if (attempts >= POLL_MAX) {
            setPolling(false);
            setAnnounce("Still being checked. Check back in a little while.");
            setNotice({
              tone: "info",
              text: "Still being checked. It can take a little longer, so check back soon.",
            });
          }
        })
        .catch(() => {
          if (!cancelled && attempts >= POLL_MAX) setPolling(false);
        });
    }, POLL_EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, id]);

  const starter =
    companyNow.status === "ready" ? (companyNow.data.company?.warehouses.starter ?? null) : null;
  const warehouse = starter ? { used: starter.used, capacity: starter.capacity } : null;
  const freeSlots = starter ? starter.capacity - starter.used : null;

  if (productId !== null && (loaded.status === "loading" || !initialised)) {
    if (loaded.status === "error") {
      return (
        <div className="flex flex-col gap-4">
          <PageHeading>Listing</PageHeading>
          <ErrorBlock message={loaded.message} onRetry={loaded.reload} />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <PageHeading>Listing</PageHeading>
        <LoadingBlock rows={4} label="Loading your listing" />
      </div>
    );
  }

  const { mode, reason: lockedReason } = modeOf(listing);

  async function saveDraft(next: ListingFormValues): Promise<ListingDetail | null> {
    setBusy(true);
    setNotice(null);
    setFieldErrors({});
    try {
      const body = draftBody(next);
      const current = idRef.current;
      const result =
        current === null
          ? await api<{ product: ListingDetail }>("/api/v1/studio/products", { method: "POST", body })
          : await api<{ product: ListingDetail }>(`/api/v1/studio/products/${current}`, {
              method: "PATCH",
              body,
            });
      if (current === null) {
        setId(result.product.id);
        idRef.current = result.product.id;
        window.history.replaceState(null, "", `/studio/${result.product.id}`);
      }
      setListing(result.product);
      return result.product;
    } catch (error) {
      reportFailure(error);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function reportFailure(error: unknown) {
    const fields = listingFieldErrors(error);
    if (Object.keys(fields).length > 0) {
      setFieldErrors(fields);
      setNotice({ tone: "danger", text: "Some fields need changes. They are marked below." });
    } else {
      setNotice({ tone: "danger", text: studioErrorText(error) });
    }
  }

  async function onSave(next: ListingFormValues) {
    if (mode === "revise" && id) {
      setBusy(true);
      setNotice(null);
      setFieldErrors({});
      try {
        const result = await api<{ product: ListingDetail }>(`/api/v1/studio/products/${id}/revise`, {
          method: "POST",
          body: revisionBody(next),
        });
        setListing(result.product);
        setNotice({
          tone: "info",
          text: "Revision sent. The current version stays live while it is checked.",
        });
        setAnnounce("Revision sent. Being checked.");
        if (screening(result.product)) setPolling(true);
        else setNotice({ tone: "success", text: outcomeText(result.product) });
      } catch (error) {
        reportFailure(error);
      } finally {
        setBusy(false);
      }
      return;
    }
    const saved = await saveDraft(next);
    if (saved) {
      setNotice({ tone: "success", text: "Draft saved. Only you can see it." });
      setAnnounce("Draft saved.");
    }
  }

  async function submitNow() {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await saveDraft(values);
      if (!saved) {
        setConfirmSubmit(false);
        return;
      }
      const result = await api<{ product: ListingDetail }>(`/api/v1/studio/products/${saved.id}/submit`, {
        method: "POST",
        body: {},
      });
      setListing(result.product);
      setConfirmSubmit(false);
      if (screening(result.product)) {
        setNotice({ tone: "info", text: "Submitted. Being checked — usually quick." });
        setAnnounce("Submitted. Being checked.");
        setPolling(true);
      } else {
        setNotice({ tone: "success", text: outcomeText(result.product) });
        setAnnounce(outcomeText(result.product));
      }
    } catch (error) {
      setConfirmSubmit(false);
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft() {
    if (!id) return;
    setBusy(true);
    try {
      await api(`/api/v1/studio/products/${id}`, { method: "DELETE" });
      window.location.assign("/studio");
    } catch (error) {
      setConfirmDelete(false);
      reportFailure(error);
      setBusy(false);
    }
  }

  const status = listing?.status ?? "DRAFT";
  const reasons =
    listing === null
      ? []
      : status === "REJECTED"
        ? reasonLines(listing.lastDecision?.reasons ?? [])
        : status === "NEEDS_REVIEW"
          ? reasonLines(listing.pending?.reasons ?? [])
          : [];
  const decisionReason =
    listing && (status === "REJECTED" || status === "HIDDEN")
      ? status === "HIDDEN"
        ? listing.moderationReason
        : (listing.lastDecision?.reason ?? listing.moderationReason)
      : null;
  const editable = mode === "draft";
  const everPublished = listing?.publishedAt != null;
  const exclusiveQty = values.inventoryMode === "EXCLUSIVE";

  return (
    <div className="flex flex-col gap-5">
      <PageHeading>
        {id === null ? "New listing" : (listing?.live?.name ?? listing?.current?.name ?? "Edit listing")}
      </PageHeading>
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>
      {listing ? (
        <ListingStatus
          status={listing.status}
          approvedNeedsStock={listing.approvedNeedsStock}
          reasons={reasons}
          moderationReason={decisionReason}
        >
          {polling ? (
            <Text size="sm" muted>
              Checking again every couple of seconds…
            </Text>
          ) : null}
          {status === "PUBLISHED" ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="secondary">
                <a href={`/p/${listing.id}`}>View the public page</a>
              </Button>
              <Button asChild variant="secondary">
                <a href={`/store/${company.handle}`}>View your shop</a>
              </Button>
            </div>
          ) : null}
          {status === "HIDDEN" ? (
            <Text size="sm" muted>
              If you think this was a mistake, an appeal option is coming. For now there is nothing to send.
            </Text>
          ) : null}
        </ListingStatus>
      ) : null}
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <ListingForm
            values={values}
            onChange={setValues}
            categories={CATEGORY_OPTIONS}
            mode={mode}
            {...(lockedReason ? { lockedReason } : {})}
            fieldErrors={fieldErrors}
            warehouse={warehouse}
            busy={busy}
            onSave={(v) => void onSave(v)}
            saveLabel={mode === "revise" ? "Send revision for review" : "Save draft"}
            {...(editable ? { onSubmitForReview: () => setConfirmSubmit(true) } : {})}
          />
          {editable && id && !everPublished ? (
            <Button variant="ghost" className="self-start text-danger" onClick={() => setConfirmDelete(true)}>
              Delete this draft
            </Button>
          ) : null}
        </div>
        <aside className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-4">
          <ListingPreview values={values} storeName={company.displayName} />
        </aside>
      </div>

      {listing?.approvedNeedsStock && listing.status === "DRAFT" ? (
        <AllocatePanel
          listing={listing}
          freeSlots={freeSlots}
          onPublished={(p, n) => {
            setListing(p);
            setNotice(n);
            setAnnounce(n.text);
            companyNow.reload();
          }}
        />
      ) : null}
      {listing?.status === "PUBLISHED" && !listing.pending ? (
        <PublishedActions
          listing={listing}
          freeSlots={freeSlots}
          onChanged={(p, n) => {
            setListing(p);
            setNotice(n);
            setAnnounce(n.text);
            companyNow.reload();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmSubmit}
        onOpenChange={setConfirmSubmit}
        title="Submit for review?"
        description="It is checked automatically first. Some listings then wait for a person to review them."
        confirmLabel="Submit for review"
        busy={busy}
        onConfirm={() => void submitNow()}
      >
        <ul className="list-disc pl-5 text-sm text-fg" aria-label="What will be locked">
          <li>
            Stock type: <strong>{exclusiveQty ? "Exclusive edition" : "Standard (restockable)"}</strong>. It
            cannot be changed after publishing.
          </li>
          {exclusiveQty ? (
            <li>
              Edition supply: <strong>{values.quantity.trim()}</strong>. The supply is fixed forever. You can
              never add more.
            </li>
          ) : (
            <li>You can restock later, as long as your warehouse has space.</li>
          )}
          <li>
            After publishing, text changes go through review again while the current version stays live.
          </li>
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this draft?"
        description="The draft is removed for good. Nothing has been published."
        confirmLabel="Delete draft"
        danger
        busy={busy}
        onConfirm={() => void deleteDraft()}
      />
    </div>
  );
}

/** An approved listing that waited for warehouse space: choose how many units to put in, then publish. */
function AllocatePanel({
  listing,
  freeSlots,
  onPublished,
}: {
  listing: ListingDetail;
  freeSlots: number | null;
  onPublished: (listing: ListingDetail, notice: Notice) => void;
}) {
  const exclusive = listing.inventoryMode === "EXCLUSIVE";
  const planned = listing.edition?.supply ?? listing.quantity ?? 1;
  const fit = freeSlots === null ? planned : Math.max(Math.min(planned, freeSlots), 0);
  const [qty, setQty] = useState(String(fit > 0 ? fit : 1));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function publish() {
    const q = /^\d{1,5}$/.test(qty.trim()) ? Number(qty.trim()) : null;
    if (!exclusive && (q === null || q < 1)) {
      setError("Enter a whole number of units, at least 1.");
      return;
    }
    if (!exclusive && q !== null && freeSlots !== null && q > freeSlots) {
      setError(`Only ${freeSlots} warehouse slots are free. Try ${Math.max(freeSlots, 1)} or fewer.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ product: ListingDetail }>(`/api/v1/studio/products/${listing.id}/stock`, {
        method: "POST",
        body: exclusive
          ? { action: "ALLOCATE_AND_PUBLISH" }
          : { action: "ALLOCATE_AND_PUBLISH", quantity: q },
      });
      onPublished(result.product, { tone: "success", text: "Published. Shoppers can buy it now." });
    } catch (e) {
      setError(studioErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="alloc-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={2} size="sm" id="alloc-heading">
        Approved: add stock to publish
      </Heading>
      <Text size="sm">
        A person approved this listing, but your warehouse did not have room at the time. Your free space is
        {freeSlots === null ? " not known right now" : ` ${freeSlots} slots`}.{" "}
        {exclusive
          ? `It needs ${planned} slots for its fixed supply.`
          : `You planned ${planned} units; pick a number that fits.`}
      </Text>
      {exclusive ? null : (
        <FormField label="Units to publish with" error={error}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="off"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          )}
        </FormField>
      )}
      {exclusive && error ? <Alert tone="danger">{error}</Alert> : null}
      <Button className="self-start" loading={busy} onClick={() => void publish()}>
        Publish now
      </Button>
    </section>
  );
}
