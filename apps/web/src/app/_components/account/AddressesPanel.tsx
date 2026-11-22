"use client";

import {
  AddressCard,
  AddressForm,
  type AddressFormValues,
  Alert,
  Button,
  Dialog,
  EmptyState,
  Heading,
  Text,
} from "@delulu/ui";
import { useEffect, useRef, useState } from "react";
import { safeReturnPath } from "../../_lib/addresses";
import { type AddressesResponse, ApiError, api, describeError, type SavedAddress } from "../../_lib/api";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

type Editing = { mode: "add" } | { mode: "edit"; address: SavedAddress } | null;
type FieldErrors = Partial<
  Record<"recipientName" | "line1" | "line2" | "city" | "state" | "postalCode", string>
>;

const SCREENED = "Remove links, email addresses or phone numbers from this field.";

function errorsOf(e: unknown): { message: string; fields: FieldErrors } {
  if (e instanceof ApiError) {
    if (e.code === "ADDRESS_LIMIT") {
      return {
        message: "You already have 5 saved addresses, the most allowed. Delete one first.",
        fields: {},
      };
    }
    if (e.code === "VALIDATION_FAILED") {
      const fields: FieldErrors = {};
      const reasons = Array.isArray(e.details.reasons) ? (e.details.reasons as { field: string }[]) : [];
      for (const r of reasons) fields[r.field as keyof FieldErrors] = SCREENED;
      const field = typeof e.details.field === "string" ? (e.details.field as keyof FieldErrors) : null;
      if (field && !fields[field]) fields[field] = "Check this.";
      return { message: "Check the highlighted fields.", fields };
    }
    if (e.code === "ADDRESS_NOT_FOUND") return { message: "That address no longer exists.", fields: {} };
  }
  return { message: describeError(e), fields: {} };
}

/** /account/addresses: the player's saved delivery addresses (PRD R5.2). */
export function AddressesPanel() {
  const loaded = useApiGet<AddressesResponse>("/api/v1/addresses");
  const [editing, setEditing] = useState<Editing>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedAddress | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setReturnTo(safeReturnPath(params.get("next")));
    if (params.get("add") === "1") setEditing({ mode: "add" });
  }, []);

  useEffect(() => {
    if (editing) formHeading.current?.focus();
  }, [editing]);

  function open(next: Editing) {
    setFormError(null);
    setFieldErrors({});
    setMessage(null);
    setEditing(next);
  }

  async function save(values: AddressFormValues) {
    if (!editing) return;
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      if (editing.mode === "add") {
        await api("/api/v1/addresses", { method: "POST", body: values });
      } else {
        await api(`/api/v1/addresses/${editing.address.id}`, {
          method: "PATCH",
          body: { label: values.label, address: values.address },
        });
        if (values.makeDefault && !editing.address.isDefault) {
          await api(`/api/v1/addresses/${editing.address.id}/default`, { method: "POST" });
        }
      }
      const added = editing.mode === "add";
      setEditing(null);
      setMessage({ tone: "success", text: added ? "Address saved." : "Address updated." });
      loaded.reload();
      if (added && returnTo) window.location.assign(returnTo);
    } catch (e) {
      const { message: m, fields } = errorsOf(e);
      setFormError(m);
      setFieldErrors(fields);
    } finally {
      setPending(false);
    }
  }

  async function makeDefault(a: SavedAddress) {
    setMessage(null);
    try {
      await api(`/api/v1/addresses/${a.id}/default`, { method: "POST" });
      setMessage({ tone: "success", text: `${a.labelName} is now your default address.` });
      loaded.reload();
    } catch (e) {
      setMessage({ tone: "danger", text: errorsOf(e).message });
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setPending(true);
    try {
      await api(`/api/v1/addresses/${deleting.id}`, { method: "DELETE" });
      setMessage({
        tone: "success",
        text: "Address deleted. Orders that used it now show “Address removed”.",
      });
      setDeleting(null);
      loaded.reload();
    } catch (e) {
      setMessage({ tone: "danger", text: errorsOf(e).message });
      setDeleting(null);
    } finally {
      setPending(false);
    }
  }

  const items = loaded.status === "ready" ? loaded.data.items : [];
  const max = loaded.status === "ready" ? loaded.data.max : 5;
  const full = items.length >= max;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>Addresses</PageHeading>
      <Text muted>
        Nothing real ships: delivery is simulated. A saved address only makes checkout and tracking feel real.
        It is stored encrypted, only you can see it, and sellers never do. The fictional delivery spot is
        always available instead.
      </Text>
      {returnTo ? (
        <a className="inline-flex min-h-touch items-center text-action underline" href={returnTo}>
          Back to checkout
        </a>
      ) : null}
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {loaded.status === "loading" ? <LoadingBlock rows={2} label="Loading your addresses" /> : null}
      {loaded.status === "error" ? <ErrorBlock message={loaded.message} onRetry={loaded.reload} /> : null}

      {editing ? (
        <section
          aria-labelledby="address-form-heading"
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        >
          <Heading level={2} size="md" id="address-form-heading" tabIndex={-1} ref={formHeading}>
            {editing.mode === "add" ? "Add an address" : `Edit ${editing.address.labelName}`}
          </Heading>
          <AddressForm
            key={editing.mode === "edit" ? editing.address.id : "new"}
            {...(editing.mode === "edit"
              ? {
                  initial: {
                    label: editing.address.label,
                    address: { ...editing.address.address, line2: editing.address.address.line2 ?? "" },
                  },
                  submitLabel: "Save changes",
                  showMakeDefault: !editing.address.isDefault,
                }
              : {})}
            pending={pending}
            error={formError}
            fieldErrors={fieldErrors}
            onCancel={() => setEditing(null)}
            onSubmit={(v) => void save(v)}
          />
        </section>
      ) : null}

      {loaded.status === "ready" && items.length === 0 && !editing ? (
        <EmptyState
          title="No saved addresses"
          description="You can shop with the fictional delivery spot, or add a real address for a more lifelike checkout."
          action={<Button onClick={() => open({ mode: "add" })}>Add an address</Button>}
        />
      ) : null}

      {items.length > 0 ? (
        <ul aria-label="Saved addresses" className="flex flex-col gap-3">
          {items.map((a) => (
            <li key={a.id}>
              <AddressCard
                label={a.labelName}
                text={a.text}
                kind="real"
                isDefault={a.isDefault}
                onEdit={() => open({ mode: "edit", address: a })}
                onDelete={() => setDeleting(a)}
                onSetDefault={() => void makeDefault(a)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {loaded.status === "ready" && items.length > 0 && !editing ? (
        full ? (
          <Text size="sm" muted>
            You have {max} saved addresses, the most allowed. Delete one to add another.
          </Text>
        ) : (
          <div>
            <Button onClick={() => open({ mode: "add" })}>Add an address</Button>
          </div>
        )
      ) : null}

      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        title={deleting ? `Delete ${deleting.labelName}?` : "Delete address?"}
        description="It is erased for good. Past orders that used it will show “Address removed”."
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDeleting(null)}>
            Keep it
          </Button>
          <Button variant="danger" loading={pending} onClick={() => void confirmDelete()}>
            Delete address
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
