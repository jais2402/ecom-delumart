"use client";

import {
  Alert,
  Button,
  EmptyState,
  Heading,
  ShopHeader,
  ShopIdentityForm,
  type ShopIdentityValues,
  Text,
  WarehouseUsage,
} from "@delulu/ui";
import { useState } from "react";
import { api } from "../../_lib/api";
import {
  type CompanyView,
  LISTING_HREF,
  reasonsByField,
  SHOP_LIMITS,
  sellingErrorText,
} from "../../_lib/selling";
import { useApiGet } from "../../_lib/use-api";
import { useRequireAccount } from "../../_lib/use-require-account";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

type Errors = Partial<Record<keyof ShopIdentityValues, string[]>>;

/** /sell/shop: the owner's view of their shop: identity, an edit form, warehouse use and sales. */
export function ShopHome() {
  const { ok } = useRequireAccount();
  const loaded = useApiGet<{ company: CompanyView | null }>(ok ? "/api/v1/company" : null);
  const [edited, setEdited] = useState<CompanyView | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  if (!ok || loaded.status === "loading") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeading>Your shop</PageHeading>
        <LoadingBlock label="Loading your shop" />
      </div>
    );
  }
  if (loaded.status === "error") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeading>Your shop</PageHeading>
        <ErrorBlock message={loaded.message} onRetry={loaded.reload} />
      </div>
    );
  }
  const company = edited ?? loaded.data.company;
  if (!company) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeading>Your shop</PageHeading>
        <EmptyState
          title="You have not registered a shop yet"
          description="Registering takes a handle, a name and a one-time setup fee of fictional money."
          action={
            <Button asChild>
              <a href="/sell/register">Register a shop</a>
            </Button>
          }
        />
      </div>
    );
  }

  const starter = company.warehouses.starter;

  async function save(values: ShopIdentityValues) {
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      const result = await api<{ company: CompanyView }>("/api/v1/company", {
        method: "PATCH",
        body: { displayName: values.displayName, description: values.description },
      });
      setEdited(result.company);
      setMessage({ tone: "success", text: "Saved. Your shop page is updated." });
    } catch (error) {
      const reasons = reasonsByField(error);
      if (Object.keys(reasons).length > 0) {
        setErrors({ displayName: reasons.displayName ?? [], description: reasons.description ?? [] });
      } else {
        setMessage({ tone: "danger", text: sellingErrorText(error) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <ShopHeader
        displayName={company.displayName}
        handle={company.handle}
        description={company.description}
        tier={company.tier}
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <a href={`/store/${company.handle}`}>View public page</a>
          </Button>
          <Button asChild>
            <a href={LISTING_HREF}>Create a listing</a>
          </Button>
        </div>
      </ShopHeader>

      <section
        aria-labelledby="warehouse"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <Heading level={2} size="sm" id="warehouse">
          Warehouse
        </Heading>
        {starter ? (
          <WarehouseUsage used={starter.used} capacity={starter.capacity} />
        ) : (
          <Text muted>Your starter warehouse is being set up.</Text>
        )}
        <Text size="sm" muted>
          {company.warehouses.count} {company.warehouses.count === 1 ? "warehouse" : "warehouses"} ·{" "}
          {company.warehouses.used} of {company.warehouses.capacity} spaces used in total
        </Text>
      </section>

      <section aria-labelledby="sales" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="sales">
          Sales
        </Heading>
        <EmptyState
          title="No player purchases yet."
          description="Create a listing to start selling."
          headingLevel={3}
        />
      </section>

      <section aria-labelledby="edit-shop" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="edit-shop">
          Edit your shop
        </Heading>
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <ShopIdentityForm
          initial={{
            handle: company.handle,
            displayName: company.displayName,
            description: company.description,
          }}
          limits={SHOP_LIMITS}
          handleFixed
          fieldErrors={errors}
          loading={busy}
          submitLabel="Save changes"
          onSubmit={(values) => void save(values)}
        />
      </section>
    </div>
  );
}
