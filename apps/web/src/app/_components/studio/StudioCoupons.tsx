"use client";

import {
  Alert,
  Badge,
  Button,
  CopyCode,
  CouponForm,
  type CouponRequest,
  DataTable,
  Heading,
  Price,
  Text,
} from "@delulu/ui";
import { useState } from "react";
import { api } from "../../_lib/api";
import {
  type CouponStatus,
  type CouponsResponse,
  describeCoupon,
  type MerchantCoupon,
  merchantErrorText,
} from "../../_lib/merchant";
import { parsePaise } from "../../_lib/money";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { ConfirmDialog } from "./ConfirmDialog";
import { PortalTitle } from "./PortalTitle";

const STATUS_TEXT: Record<CouponStatus, { label: string; tone: "success" | "warning" | "neutral" }> = {
  ACTIVE: { label: "Active", tone: "success" },
  PAUSED: { label: "Paused", tone: "warning" },
  ENDED: { label: "Ended", tone: "neutral" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
};

/** /studio/coupons: the shop's coupons, their results, and a form for a new one. Discounts come out of the seller's proceeds. */
export function StudioCoupons() {
  const loaded = useApiGet<CouponsResponse>("/api/v1/studio/coupons");
  return (
    <div className="flex flex-col gap-6">
      <PortalTitle>Coupons</PortalTitle>
      {loaded.status === "loading" ? <LoadingBlock rows={3} label="Loading your coupons" /> : null}
      {loaded.status === "error" ? <ErrorBlock message={loaded.message} onRetry={loaded.reload} /> : null}
      {loaded.status === "ready" ? <Body data={loaded.data} reload={loaded.reload} /> : null}
    </div>
  );
}

function Body({ data, reload }: { data: CouponsResponse; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; code: string; isPublic: boolean } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [confirm, setConfirm] = useState<{ coupon: MerchantCoupon; status: "PAUSED" | "ENDED" } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function create(request: CouponRequest) {
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const made = await api<{ id: string; code: string }>("/api/v1/studio/coupons", {
        method: "POST",
        body: request,
      });
      setCreated({ ...made, isPublic: request.isPublic });
      setFormKey((k) => k + 1);
      reload();
    } catch (e) {
      setError(merchantErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(coupon: MerchantCoupon, status: CouponStatus) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/api/v1/studio/coupons/${coupon.id}/status`, { method: "POST", body: { status } });
      setNotice(`Coupon ${coupon.code} is now ${STATUS_TEXT[status].label.toLowerCase()}.`);
      setConfirm(null);
      reload();
    } catch (e) {
      setActionError(merchantErrorText(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  const atLimit = data.activeCount >= data.activeMax;

  return (
    <>
      <Alert tone="info">Discounts come out of your proceeds. DeluluMart does not pay for them.</Alert>
      <Text data-testid="coupon-count" className="font-medium">
        {data.activeCount} of {data.activeMax} active
      </Text>
      <span role="status" aria-live="polite" className="sr-only">
        {notice ?? ""}
      </span>
      {actionError ? <Alert tone="danger">{actionError}</Alert> : null}
      {created ? (
        <Alert tone="success" title="Coupon created">
          {created.isPublic ? (
            <>
              Your public code <strong>{created.code}</strong> now shows on your shop page.
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <span>This private code is shown to you only. Share it with the people you choose.</span>
              <CopyCode code={created.code} noun="private coupon code" data-testid="private-code" />
            </div>
          )}
        </Alert>
      ) : null}

      <section aria-labelledby="cp-list" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="cp-list">
          Your coupons
        </Heading>
        <DataTable
          caption="Your coupons"
          emptyTitle="No coupons yet"
          emptyDescription="Make one below. It takes a minute."
          rows={data.items}
          rowKey={(c) => c.id}
          columns={[
            {
              key: "code",
              header: "Code",
              cell: (c) => (
                <span className="flex flex-col gap-1">
                  <code className="font-mono">{c.code}</code>
                  <span className="text-xs text-fg-muted">{c.isPublic ? "Public" : "Private"}</span>
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (c) => <Badge tone={STATUS_TEXT[c.status].tone}>{STATUS_TEXT[c.status].label}</Badge>,
            },
            {
              key: "terms",
              header: "Terms",
              cell: (c) => (
                <ul className="list-disc pl-4">
                  {describeCoupon(c).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ),
            },
            { key: "redeemed", header: "Used", align: "right", cell: (c) => c.redeemed },
            {
              key: "given",
              header: "Discount given",
              align: "right",
              cell: (c) => <Price amountPaise={parsePaise(c.discountGivenPaise)} display="exact" />,
            },
            {
              key: "actions",
              header: "Actions",
              cell: (c) => (
                <span className="flex flex-wrap gap-2">
                  {c.status === "ACTIVE" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Pause coupon ${c.code}`}
                      onClick={() => setConfirm({ coupon: c, status: "PAUSED" })}
                    >
                      Pause
                    </Button>
                  ) : null}
                  {c.status === "PAUSED" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-label={`Resume coupon ${c.code}`}
                      onClick={() => void setStatus(c, "ACTIVE")}
                    >
                      Resume
                    </Button>
                  ) : null}
                  {c.status === "ACTIVE" || c.status === "PAUSED" ? (
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`End coupon ${c.code}`}
                      onClick={() => setConfirm({ coupon: c, status: "ENDED" })}
                    >
                      End
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </section>

      <section
        aria-labelledby="cp-new"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <Heading level={2} size="sm" id="cp-new">
          New coupon
        </Heading>
        {atLimit ? (
          <Alert tone="warning">
            You have {data.activeMax} active coupons, the most allowed. A new one will be refused until you
            pause or end one.
          </Alert>
        ) : null}
        <CouponForm onSubmit={(r) => void create(r)} busy={busy} error={error} resetKey={formKey} />
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={
          confirm?.status === "ENDED"
            ? `End coupon ${confirm.coupon.code}?`
            : `Pause coupon ${confirm?.coupon.code ?? ""}?`
        }
        description={
          confirm?.status === "ENDED"
            ? "An ended coupon stops working for good and cannot be turned back on."
            : "A paused coupon stops working until you resume it."
        }
        confirmLabel={confirm?.status === "ENDED" ? "End coupon" : "Pause coupon"}
        danger={confirm?.status === "ENDED"}
        busy={busy}
        onConfirm={() => confirm && void setStatus(confirm.coupon, confirm.status)}
      />
    </>
  );
}
