"use client";

import { LISTING_RULES } from "@delulu/core";
import {
  Alert,
  Button,
  Checkbox,
  FormField,
  Heading,
  Input,
  Price,
  parseRupees,
  priceReading,
  Text,
} from "@delulu/ui";
import { type ReactNode, useState } from "react";
import { api } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { type ListingDetail, listingFieldErrors, studioErrorText } from "../../_lib/studio";
import { ConfirmDialog } from "./ConfirmDialog";

type Notice = { tone: "success" | "danger"; text: string };

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={3} size="sm" id={id}>
        {title}
      </Heading>
      {children}
    </section>
  );
}

const quantityOf = (text: string): number | null =>
  /^\d{1,5}$/.test(text.trim()) ? Number(text.trim()) : null;

/**
 * What the owner can do with a live listing: change the price, restock, retire unsold units,
 * change delivery, archive. Each action says what it will do first and reports what happened.
 */
export function PublishedActions({
  listing,
  freeSlots,
  onChanged,
}: {
  listing: ListingDetail;
  /** Free warehouse slots, or null when not known. */
  freeSlots: number | null;
  onChanged: (listing: ListingDetail, notice: Notice) => void;
}) {
  const exclusive = listing.inventoryMode === "EXCLUSIVE";
  const livePrice = listing.live ? parsePaise(listing.live.pricePaise) : null;
  const [price, setPrice] = useState("");
  const [priceError, setPriceError] = useState<string | null>(null);
  const [restock, setRestock] = useState("");
  const [retire, setRetire] = useState("");
  const [qtyError, setQtyError] = useState<Record<string, string | null>>({});
  const [express, setExpress] = useState(listing.offersExpress);
  const [freeStd, setFreeStd] = useState(listing.freeStandardDelivery);
  const [confirm, setConfirm] = useState<null | "price" | "retire" | "archive">(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function run(label: string, path: string, body: unknown, after?: () => void) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<{ product: ListingDetail; retired?: number; sellableSupply?: number }>(
        `/api/v1/studio/products/${listing.id}${path}`,
        { method: "POST", body },
      );
      after?.();
      setConfirm(null);
      onChanged(result.product, { tone: "success", text: label });
    } catch (error) {
      setConfirm(null);
      const fields = listingFieldErrors(error);
      const first = Object.values(fields)[0]?.[0];
      setNotice({ tone: "danger", text: first ?? studioErrorText(error) });
    } finally {
      setBusy(false);
    }
  }

  function askPrice() {
    const rupees = parseRupees(price);
    const { min, max } = LISTING_RULES.priceRupees;
    if (rupees === null || rupees < BigInt(min) || rupees > BigInt(max)) {
      setPriceError(`Enter whole rupees from ${min} to ${max}.`);
      return;
    }
    setPriceError(null);
    setConfirm("price");
  }

  function askRetire() {
    const q = quantityOf(retire);
    if (q === null || q < 1 || q > listing.stock.available) {
      setQtyError({ retire: `Enter a number from 1 to ${listing.stock.available} (your unsold units).` });
      return;
    }
    setQtyError({});
    setConfirm("retire");
  }

  function doRestock() {
    const q = quantityOf(restock);
    if (q === null || q < 1) {
      setQtyError({ restock: "Enter a whole number of units, at least 1." });
      return;
    }
    if (freeSlots !== null && q > freeSlots) {
      setQtyError({ restock: `Only ${freeSlots} warehouse slots are free.` });
      return;
    }
    setQtyError({});
    void run(
      `Restocked: ${q} more ${q === 1 ? "unit" : "units"} added.`,
      "/stock",
      { action: "RESTOCK", quantity: q },
      () => setRestock(""),
    );
  }

  const newRupees = parseRupees(price);
  const retireCount = quantityOf(retire) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Heading level={2} size="sm">
        Manage this listing
      </Heading>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}

      <Section title="Price" id="act-price">
        <Text size="sm">
          Current price: {livePrice !== null ? <Price amountPaise={livePrice} display="exact" /> : "—"}
        </Text>
        <FormField
          label="New price in rupees"
          hint={priceReading(price) ?? "Whole rupees."}
          error={priceError}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="off"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          )}
        </FormField>
        <Button variant="secondary" className="self-start" disabled={busy} onClick={askPrice}>
          Change price
        </Button>
      </Section>

      <Section title="Stock" id="act-stock">
        <Text size="sm">
          {listing.stock.available} available · {listing.stock.issued} sold · {listing.stock.retired} retired
          {listing.edition ? ` · edition of ${listing.edition.supply}` : ""}
        </Text>
        {exclusive ? (
          <Text size="sm" muted>
            This is an exclusive edition. Its supply is fixed forever, so it cannot be restocked.
          </Text>
        ) : (
          <>
            <FormField
              label="Units to add"
              error={qtyError.restock ?? null}
              hint={freeSlots !== null ? `${freeSlots} warehouse slots are free.` : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="numeric"
                  autoComplete="off"
                  value={restock}
                  onChange={(e) => setRestock(e.target.value)}
                />
              )}
            </FormField>
            <Button variant="secondary" className="self-start" loading={busy} onClick={doRestock}>
              Restock
            </Button>
          </>
        )}
        {listing.stock.available > 0 ? (
          <>
            <FormField label="Unsold units to retire" error={qtyError.retire ?? null}>
              {(control) => (
                <Input
                  {...control}
                  inputMode="numeric"
                  autoComplete="off"
                  value={retire}
                  onChange={(e) => setRetire(e.target.value)}
                />
              )}
            </FormField>
            <Button variant="secondary" className="self-start" disabled={busy} onClick={askRetire}>
              Retire units
            </Button>
          </>
        ) : null}
      </Section>

      <Section title="Delivery" id="act-delivery">
        <div className="flex flex-col gap-1">
          <Checkbox
            checked={express}
            onChange={(e) => setExpress(e.target.checked)}
            label="Offer Express delivery"
          />
          <Checkbox
            checked={freeStd}
            onChange={(e) => setFreeStd(e.target.checked)}
            label="Free Standard delivery for buyers"
          />
          {freeStd ? (
            <Text size="sm">You pay for it: the delivery fee comes out of your proceeds on every order.</Text>
          ) : null}
        </div>
        <Button
          variant="secondary"
          className="self-start"
          loading={busy}
          onClick={() =>
            void run("Delivery options saved.", "/shipping", {
              offersExpress: express,
              freeStandardDelivery: freeStd,
            })
          }
        >
          Save delivery options
        </Button>
      </Section>

      <Section title="Archive" id="act-archive">
        <Text size="sm" muted>
          Archiving takes the listing off the shop. Anyone who already bought it keeps it.
        </Text>
        <Button variant="danger" className="self-start" disabled={busy} onClick={() => setConfirm("archive")}>
          Archive listing
        </Button>
      </Section>

      <ConfirmDialog
        open={confirm === "price"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Change the price?"
        description="Shoppers see the new price straight away. People who already bought are not affected."
        confirmLabel="Change price"
        busy={busy}
        onConfirm={() =>
          void run(
            "Price changed. Shoppers see the new price now.",
            "/price",
            {
              priceRupees: Number((newRupees ?? 0n).toString()),
            },
            () => setPrice(""),
          )
        }
      >
        <Text size="sm">
          {livePrice !== null ? (
            <>
              From <Price amountPaise={livePrice} display="exact" /> to{" "}
            </>
          ) : (
            "To "
          )}
          <Price amountPaise={(newRupees ?? 0n) * 100n} display="exact" />.
        </Text>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "retire"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Retire ${retireCount} unsold ${retireCount === 1 ? "unit" : "units"}?`}
        description={
          exclusive
            ? "This permanently lowers how many of this edition can ever be sold. The supply is fixed and cannot be restored."
            : "These units leave your warehouse and cannot be sold. Retired units cannot be brought back."
        }
        confirmLabel="Retire units"
        danger
        busy={busy}
        onConfirm={() =>
          void run(
            `Retired ${retireCount} ${retireCount === 1 ? "unit" : "units"}.`,
            "/stock",
            { action: "RETIRE", quantity: retireCount },
            () => setRetire(""),
          )
        }
      />
      <ConfirmDialog
        open={confirm === "archive"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Archive this listing?"
        description="It disappears from your shop and from search. This cannot be undone from here."
        confirmLabel="Archive listing"
        danger
        busy={busy}
        onConfirm={() => void run("Listing archived.", "/archive", {})}
      />
    </div>
  );
}
