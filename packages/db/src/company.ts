/**
 * Company registration and the store (migration 0034). The quote and the registration are money
 * commands run as app_pay; reading and editing one's own company and the public store lookup run
 * as app_web. The database derives the actor from the sign-in session, verifies the handle, name
 * and description rules itself, and takes the text screening verdict on the web server's word (the
 * web layer calls these only for text screened OK). The payment attempt and its PIN step are the
 * purchase ones (createPaymentAttempt, verifyCardPin).
 */
import { createHash } from "node:crypto";
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { PayFailure, type Refusal } from "./checkout";
import { asPay, asWeb, domainErrorOf, one, requireUuid } from "./command";

export interface CompanyQuote {
  sessionId: string;
  expiresAt: Date;
  handle: string;
  displayName: string;
  description: string;
  feePaise: bigint;
  /** The formation sponsorship that would cover a shortfall (0 when none applies). */
  sponsorshipPaise: bigint;
  /** What the owner's balance pays: the fee less any sponsorship. */
  payablePaise: bigint;
  balancePaise: bigint;
  /** Null when the balance does not cover the payable amount. */
  balanceAfterPaise: bigint | null;
  sufficient: boolean;
}

export interface CompanyReceipt {
  companyId: string;
  registrationId: string;
  handle: string;
  displayName: string;
  tier: "SOLO";
  warehouseId: string;
  feePaise: bigint;
  paidPaise: bigint;
  sponsorshipPaise: bigint;
  balanceAfterPaise: bigint;
  paymentReference: string;
  /** True when returned from the idempotency record. */
  replayed: boolean;
}

export interface Company {
  companyId: string;
  handle: string | null;
  displayName: string;
  description: string;
  tier: "SOLO" | "BRAND";
  registeredAt: Date;
  warehouses: {
    count: number;
    capacity: number;
    used: number;
    starter: { id: string; capacity: number; used: number } | null;
  };
}

export interface Store {
  handle: string;
  displayName: string;
  description: string;
  tier: "SOLO" | "BRAND";
}

interface StoredQuote {
  sessionId: string;
  expiresAt: string;
  handle: string;
  displayName: string;
  description: string;
  feePaise: string;
  sponsorshipPaise: string;
  payablePaise: string;
  balancePaise: string | null;
  balanceAfterPaise: string | null;
  sufficient: boolean | null;
}

interface StoredReceipt {
  companyId: string;
  registrationId: string;
  handle: string;
  displayName: string;
  tier: "SOLO";
  warehouseId: string;
  feePaise: string;
  paidPaise: string;
  sponsorshipPaise: string;
  balanceAfterPaise: string;
  paymentReference: string;
}

interface StoredCompany {
  companyId: string;
  handle: string | null;
  displayName: string;
  description: string;
  tier: "SOLO" | "BRAND";
  registeredAt: string;
  warehouses: {
    count: number;
    capacity: number;
    used: number;
    starter: { id: string; capacity: number; used: number } | null;
  };
}

function companyOf(c: StoredCompany): Company {
  return {
    companyId: c.companyId,
    handle: c.handle,
    displayName: c.displayName,
    description: c.description,
    tier: c.tier,
    registeredAt: new Date(c.registeredAt),
    warehouses: {
      count: Number(c.warehouses.count),
      capacity: Number(c.warehouses.capacity),
      used: Number(c.warehouses.used),
      starter: c.warehouses.starter,
    },
  };
}

/** A registration quote: reserves the handle for the configured time and prices the fee. */
export async function companyQuote(
  pool: Pool,
  input: { authSessionId: string; handle: string; displayName: string; description: string },
): Promise<CompanyQuote> {
  const q = await asPay(pool, input.authSessionId, (c) =>
    one<StoredQuote>(c, "SELECT core.company_quote($1, $2, $3) AS r", [
      input.handle,
      input.displayName,
      input.description,
    ]),
  );
  return {
    sessionId: q.sessionId,
    expiresAt: new Date(q.expiresAt),
    handle: q.handle,
    displayName: q.displayName,
    description: q.description,
    feePaise: BigInt(q.feePaise),
    sponsorshipPaise: BigInt(q.sponsorshipPaise),
    payablePaise: BigInt(q.payablePaise),
    balancePaise: BigInt(q.balancePaise ?? "0"),
    balanceAfterPaise: q.balanceAfterPaise === null ? null : BigInt(q.balanceAfterPaise),
    sufficient: q.sufficient === true,
  };
}

type RegisterOutcome =
  | { status: "SUCCEEDED"; receipt: StoredReceipt; replayed: boolean }
  | { status: "FAILED"; error: Refusal; replayed: boolean };

const REGISTER = "company.register";

/**
 * The registration's pay transaction (core.commit_company_registration). Idempotent per (user,
 * key); at most one company and one charge per person. A refusal leaves no company and no debit:
 * the attempt is recorded FAILED and the refusal stored under the key, and this throws PayFailure.
 */
export async function registerCompany(
  pool: Pool,
  input: { authSessionId: string; sessionId: string; attemptId: string; idempotencyKey: string },
): Promise<CompanyReceipt> {
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey.length > 200
  ) {
    throw new DomainError("VALIDATION_FAILED", "idempotency key must be 1–200 characters");
  }
  requireUuid(input.sessionId, "sessionId");
  requireUuid(input.attemptId, "attemptId");
  const hash = createHash("sha256")
    .update(`${REGISTER}\n${JSON.stringify({ sessionId: input.sessionId, attemptId: input.attemptId })}`)
    .digest();
  const outcome = await asPay(pool, input.authSessionId, (c) =>
    one<RegisterOutcome>(c, "SELECT core.commit_company_registration($1, $2, $3, $4) AS r", [
      input.sessionId,
      input.attemptId,
      input.idempotencyKey,
      hash,
    ]),
  );
  if (outcome.status === "FAILED") {
    const failure = domainErrorOf(outcome.error);
    throw new PayFailure(failure.code, failure.message, {}, outcome.replayed);
  }
  const r = outcome.receipt;
  return {
    companyId: r.companyId,
    registrationId: r.registrationId,
    handle: r.handle,
    displayName: r.displayName,
    tier: r.tier,
    warehouseId: r.warehouseId,
    feePaise: BigInt(r.feePaise),
    paidPaise: BigInt(r.paidPaise),
    sponsorshipPaise: BigInt(r.sponsorshipPaise),
    balanceAfterPaise: BigInt(r.balanceAfterPaise),
    paymentReference: r.paymentReference,
    replayed: outcome.replayed,
  };
}

export async function myCompany(pool: Pool, input: { authSessionId: string }): Promise<Company | null> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ company: StoredCompany | null }>(c, "SELECT core.my_company() AS r", []),
  );
  return r.company === null ? null : companyOf(r.company);
}

/** The owner edits the display name and description (an omitted field is unchanged). */
export async function updateStore(
  pool: Pool,
  input: { authSessionId: string; displayName?: string; description?: string },
): Promise<Company> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ company: StoredCompany }>(c, "SELECT core.update_store($1, $2) AS r", [
      input.displayName ?? null,
      input.description ?? null,
    ]),
  );
  return companyOf(r.company);
}

/** A registered store's public face, or null. Needs no sign-in session. */
export async function storeByHandle(pool: Pool, handle: string): Promise<Store | null> {
  const r = await asWeb(pool, null, (c) =>
    one<{ store: Store | null }>(c, "SELECT core.store_by_handle($1) AS r", [handle]),
  );
  return r.store;
}
