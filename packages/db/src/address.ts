/**
 * Delivery addresses (PRD R5.2) through the owner-run definer functions of migration 0058. The
 * address itself is AES-256-GCM ciphertext made by the web deployment (LLD §5.6): the database
 * never sees a plain name, street, city, state or PIN code, and no application role reads or writes
 * the address tables directly. Address-book commands run as app_web; the checkout destination runs
 * as the money-command role app_pay, like the rest of checkout.
 */
import { ADDRESS_LABELS, type AddressLabel, DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { asPay, asWeb, isUuid, one, requireUuid } from "./command";

export interface StoredAddress {
  id: string;
  label: AddressLabel;
  isDefault: boolean;
  /** keyId ‖ nonce ‖ ciphertext ‖ tag, bound to ("address", userId). */
  payloadEnc: Buffer;
  createdAt: Date;
  updatedAt: Date;
}

interface AddressJson {
  id: string;
  label: AddressLabel;
  isDefault: boolean;
  payloadEnc: string;
  createdAt: string;
  updatedAt: string;
}

/** Smallest and largest sealed payload: 1-byte key id, 12-byte nonce, 16-byte tag; 4 KiB cap. */
export const ADDRESS_PAYLOAD_BYTES = { min: 29, max: 4096 } as const;

function addressOf(j: AddressJson): StoredAddress {
  return {
    id: j.id,
    label: j.label,
    isDefault: j.isDefault,
    payloadEnc: Buffer.from(j.payloadEnc, "base64"),
    createdAt: new Date(j.createdAt),
    updatedAt: new Date(j.updatedAt),
  };
}

function requireLabel(label: unknown): void {
  if (!(ADDRESS_LABELS as readonly unknown[]).includes(label)) {
    throw new DomainError("VALIDATION_FAILED", "label is HOME, WORK or OTHER", { field: "label" });
  }
}

function requirePayload(payload: unknown): void {
  if (
    !Buffer.isBuffer(payload) ||
    payload.length < ADDRESS_PAYLOAD_BYTES.min ||
    payload.length > ADDRESS_PAYLOAD_BYTES.max
  ) {
    throw new DomainError("VALIDATION_FAILED", "an encrypted address is required", { field: "payloadEnc" });
  }
}

interface Session {
  authSessionId: string;
}

export async function myAddresses(pool: Pool, input: Session): Promise<StoredAddress[]> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<AddressJson[]>(c, "SELECT core.my_addresses() AS r", []),
  );
  return r.map(addressOf);
}

export async function createAddress(
  pool: Pool,
  input: Session & { label: AddressLabel; payloadEnc: Buffer; makeDefault?: boolean },
): Promise<StoredAddress> {
  requireLabel(input.label);
  requirePayload(input.payloadEnc);
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<AddressJson>(c, "SELECT core.address_create($1, $2, $3) AS r", [
      input.label,
      input.payloadEnc,
      input.makeDefault === true,
    ]),
  );
  return addressOf(r);
}

/** Changes the label, the encrypted address, or both. Past orders keep their own copy. */
export async function updateAddress(
  pool: Pool,
  input: Session & { addressId: string; label?: AddressLabel; payloadEnc?: Buffer },
): Promise<StoredAddress> {
  if (!isUuid(input.addressId)) throw new DomainError("ADDRESS_NOT_FOUND", "address not found");
  if (input.label === undefined && input.payloadEnc === undefined) {
    throw new DomainError("VALIDATION_FAILED", "nothing to change");
  }
  if (input.label !== undefined) requireLabel(input.label);
  if (input.payloadEnc !== undefined) requirePayload(input.payloadEnc);
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<AddressJson>(c, "SELECT core.address_update($1, $2, $3) AS r", [
      input.addressId,
      input.label ?? null,
      input.payloadEnc ?? null,
    ]),
  );
  return addressOf(r);
}

/**
 * Deletes the address for real (PRD R5.2): past orders that used it keep only "Address removed".
 * Returns the id of the default address afterwards (the most recent one when the default went).
 */
export async function deleteAddress(
  pool: Pool,
  input: Session & { addressId: string },
): Promise<{ deletedId: string; defaultAddressId: string | null }> {
  if (!isUuid(input.addressId)) throw new DomainError("ADDRESS_NOT_FOUND", "address not found");
  return asWeb(pool, input.authSessionId, (c) =>
    one<{ deletedId: string; defaultAddressId: string | null }>(c, "SELECT core.address_delete($1) AS r", [
      input.addressId,
    ]),
  );
}

export async function setDefaultAddress(
  pool: Pool,
  input: Session & { addressId: string },
): Promise<StoredAddress> {
  if (!isUuid(input.addressId)) throw new DomainError("ADDRESS_NOT_FOUND", "address not found");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<AddressJson>(c, "SELECT core.address_set_default($1) AS r", [input.addressId]),
  );
  return addressOf(r);
}

// ---------------------------------------------------------------------------- checkout

export type Destination = { deliverTo: "FICTIONAL_SPOT" } | { deliverTo: "ADDRESS"; addressId: string };

/**
 * Where an open checkout session delivers: one of the actor's own saved addresses, or the
 * fictional delivery spot (the pre-selected default, decisions.md #4). The address never changes
 * the price (PRD R5.2: fees and promises do not depend on it), so the quote is untouched.
 */
export async function setCheckoutDestination(
  pool: Pool,
  input: Session & { sessionId: string; destination: Destination },
): Promise<{ sessionId: string } & Destination> {
  requireUuid(input.sessionId, "sessionId");
  const addressId = input.destination.deliverTo === "ADDRESS" ? input.destination.addressId : null;
  if (addressId !== null && !isUuid(addressId))
    throw new DomainError("ADDRESS_NOT_FOUND", "address not found");
  return asPay(pool, input.authSessionId, (c) =>
    one<{ sessionId: string } & Destination>(c, "SELECT core.checkout_set_destination($1, $2) AS r", [
      input.sessionId,
      addressId,
    ]),
  );
}

// ---------------------------------------------------------------------------- orders

export type OrderDelivery =
  | { kind: "FICTIONAL_SPOT" }
  | { kind: "ADDRESS"; label: AddressLabel; payloadEnc: Buffer }
  | { kind: "ADDRESS_REMOVED" };

/** The delivery destination snapshot of one of the actor's own order groups; null for anyone else's. */
export async function myOrderDelivery(
  pool: Pool,
  input: Session & { orderGroupId: string },
): Promise<OrderDelivery | null> {
  if (!isUuid(input.orderGroupId)) return null;
  const { rows } = await asWeb(pool, input.authSessionId, (c) =>
    c.query<{ r: { kind: string; label?: AddressLabel; payloadEnc?: string } | null }>(
      "SELECT core.my_order_delivery($1) AS r",
      [input.orderGroupId],
    ),
  );
  const r = rows[0]?.r ?? null;
  if (r === null) return null;
  if (r.kind === "ADDRESS" && r.label && r.payloadEnc) {
    return { kind: "ADDRESS", label: r.label, payloadEnc: Buffer.from(r.payloadEnc, "base64") };
  }
  if (r.kind === "ADDRESS_REMOVED") return { kind: "ADDRESS_REMOVED" };
  return { kind: "FICTIONAL_SPOT" };
}
