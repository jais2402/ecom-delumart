import "./server-only";
import { timingSafeEqual } from "node:crypto";
import { DomainError, type ErrorCode } from "@delulu/core";
import { type SessionActor, sessionActor } from "@delulu/db/runtime";
import { z } from "zod";
import { clientAddress } from "./client-address";
import { SERVER_CONFIG } from "./config";
import { sessionCsrfToken } from "./crypto";
import { webPool } from "./db";
import { env } from "./env";
import { enforceRate, type RateRule } from "./rate-limit";
import { cookieNames, readCookie, readSessionId } from "./session";

/**
 * The route-handler wrapper (LLD §8.1, §8.3, §11.1). Every API route is `route(options, fn)`:
 *  1. state-changing methods need Origin === APP_ORIGIN and the double-submit CSRF token
 *     (cookie dm_csrf and header x-csrf-token); for a signed-in request the token must also be
 *     HMAC(server key, session id), so a token minted for one session fails for another (only the
 *     sign-in route accepts a pre-session random token);
 *  2. database rate limits (rate-limit.ts): per client address before authentication, per user
 *     after it (each hit committed on its own before the business call);
 *  3. an Idempotency-Key header (UUID) where the route declares one;
 *  4. auth "session": a live sign-in session from the cookie, checked against the database, or
 *     401 AUTH_REQUIRED; "anonymous": no session needed; "public": the cookie is never read;
 *  5. the JSON body and the query string, each through a strict zod schema;
 *  6. DomainError → the error envelope with its HTTP status; any other error → a generic 500
 *     that names nothing (no message, stack, SQL or secret).
 * Every response of a non-public route is `Cache-Control: private, no-store`.
 */

export const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=300";
/**
 * Public data that a moderator can take down (reviews): a short shared cache and no stale serving,
 * so a hidden review leaves every cache within a minute (review round 1, minor 2).
 */
export const PUBLIC_SHORT_CACHE = "public, s-maxage=30";
export const PRIVATE_CACHE = "private, no-store";

export type ApiErrorCode = ErrorCode | "INTERNAL";

export interface ErrorEnvelope {
  error: { code: ApiErrorCode; message: string; retryable: boolean; details: Record<string, unknown> };
}

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  PHONE_INVALID: 422,
  PIN_WEAK: 422,
  PIN_INCORRECT: 422,
  PHONE_CODE_FAILED: 422,
  COUPON_INVALID: 422,
  COUPON_NOT_APPLICABLE: 422,
  INSUFFICIENT_FUNDS: 422,
  DELIVERY_UNAVAILABLE: 422,
  METHOD_UNAVAILABLE: 422,
  SELF_PURCHASE: 422,
  AUTH_REQUIRED: 401,
  REAUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  UNDERAGE: 403,
  PHONE_REQUIRED: 403,
  CARD_NOT_OWNED: 403,
  MERCHANT_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CART_CHANGED: 409,
  CART_FULL: 409,
  PRICE_CHANGED: 409,
  SOLD_OUT: 409,
  ALREADY_OWNED: 409,
  PRODUCT_UNAVAILABLE: 409,
  CHECKOUT_EXPIRED: 409,
  PAYMENT_PENDING: 409,
  CARD_FROZEN: 409,
  CARD_REPLACED: 409,
  PIN_NOT_SET: 409,
  PIN_LOCKED: 409,
  CHALLENGE_LOCKED: 409,
  ONBOARDING_REQUIRED: 403,
  CREATOR_LOCKED: 403,
  COMPANY_EXISTS: 409,
  HANDLE_TAKEN: 409,
  HANDLE_RESERVED: 409,
  RELIEF_NOT_ELIGIBLE: 409,
  RELIEF_LIMIT: 409,
  COMPANY_FEE_REQUIRED: 403,
  DRAFT_LIMIT: 409,
  PUBLISH_LIMIT: 409,
  CAPACITY_EXCEEDED: 409,
  NOT_EDITABLE: 409,
  SUBMISSION_LIMIT: 429,
  PUBLICATION_PAUSED: 503,
  REPORT_LIMIT: 429,
  ALREADY_REPORTED: 409,
  APPEAL_EXISTS: 409,
  NOT_APPEALABLE: 409,
  COUPON_LIMIT: 409,
  ADDRESS_NOT_FOUND: 404,
  ADDRESS_LIMIT: 409,
  CAPTCHA_FAILED: 403,
  REVIEW_NOT_ALLOWED: 403,
  REVIEW_NOT_FOUND: 404,
  REVIEW_INVALID: 422,
  REFERENCE_PRICE_INELIGIBLE: 422,
  RATE_LIMITED: 429,
  BUSY: 503,
  MAINTENANCE: 503,
};

/** A malformed request (shape, JSON, headers): 400 rather than the domain's 422. */
export class RequestError extends DomainError {}

const RETRYABLE: ReadonlySet<ApiErrorCode> = new Set([
  "BUSY",
  "RATE_LIMITED",
  "PAYMENT_PENDING",
  "MAINTENANCE",
  "PUBLICATION_PAUSED",
  "REPORT_LIMIT",
]);

/** Detail keys that may reach the client; anything else a DomainError carries is dropped. */
const SAFE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "reason",
  "remainingTries",
  "field",
  "seller",
  "adultAge",
  "retryAfterSeconds",
  "issues",
  // screening refusals: [{field, code}] per input field (no text is echoed)
  "reasons",
  // passport quiz: the ids of the questions answered wrongly (never the right options)
  "wrong",
]);

function safeDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if ((key === "issues" || key === "reasons" || key === "wrong") && Array.isArray(value)) out[key] = value;
    else if (["string", "number", "boolean"].includes(typeof value)) out[key] = value;
  }
  return out;
}

/** Errors that mean the database is unreachable or overloaded: retryable, never a fault message. */
const UNAVAILABLE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "57P01",
  "57P03",
  "53300",
  "08006",
  "08001",
]);

export function errorResponse(error: unknown, cacheControl: string): Response {
  let status: number;
  let body: ErrorEnvelope;
  if (error instanceof DomainError) {
    status = error instanceof RequestError ? 400 : (STATUS[error.code] ?? 422);
    body = {
      error: {
        code: error.code,
        message: error.message,
        retryable: RETRYABLE.has(error.code),
        details: safeDetails(error.details),
      },
    };
  } else {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && UNAVAILABLE.has(code)) {
      status = 503;
      body = { error: { code: "BUSY", message: "Busy right now. Try again.", retryable: true, details: {} } };
    } else {
      status = 500;
      body = {
        error: {
          code: "INTERNAL",
          message: "Something went wrong. Try again.",
          retryable: false,
          details: {},
        },
      };
    }
    // name and SQLSTATE only: a message can carry SQL, values or a session id
    console.error("[api] unexpected error", (error as Error | null)?.name ?? typeof error, code ?? "");
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl },
  });
}

// ------------------------------------------------------------------ request checks

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID = z.uuid();

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function checkCsrf(request: Request, appOrigin: string): void {
  const origin = request.headers.get("origin");
  if (origin === null || origin !== appOrigin) {
    throw new DomainError("FORBIDDEN", "Cross-site request refused.");
  }
  const cookie = readCookie(request, cookieNames(appOrigin).csrf);
  const header = request.headers.get("x-csrf-token");
  if (!cookie || !header || !sameToken(cookie, header)) {
    throw new DomainError("FORBIDDEN", "Missing or invalid CSRF token. Fetch /api/v1/auth/csrf and retry.");
  }
}

/** A signed-in request's token must be the one bound to its session (constant-time compare). */
function checkSessionCsrf(request: Request, sessionId: string): void {
  const header = request.headers.get("x-csrf-token") ?? "";
  if (!sameToken(header, sessionCsrfToken(sessionId))) {
    throw new DomainError("FORBIDDEN", "Missing or invalid CSRF token. Fetch /api/v1/auth/csrf and retry.");
  }
}

function validationError(error: z.ZodError): DomainError {
  return new RequestError("VALIDATION_FAILED", "The request is not valid.", {
    // path and issue code only: zod messages and inputs are never echoed (a PIN could be one)
    issues: error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
  });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > SERVER_CONFIG.http.maxBodyBytes) {
    throw new RequestError("VALIDATION_FAILED", "The request body is too large.");
  }
  if (text.trim() === "") return {};
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new RequestError("VALIDATION_FAILED", "Send the body as application/json.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError("VALIDATION_FAILED", "The request body is not valid JSON.");
  }
}

// ------------------------------------------------------------------ the wrapper

export interface SessionContext {
  /** The auth.sessions id: pass it to the database only; never log or return it. */
  id: string;
  actor: SessionActor;
}

export interface RouteContext<B, Q> {
  request: Request;
  body: B;
  query: Q;
  params: Readonly<Record<string, string>>;
  idempotencyKey: string;
  /** Present for auth "session" routes. */
  session: SessionContext;
  /** The cookie's session id for auth "anonymous" routes (unchecked); null if absent. */
  cookieSessionId: string | null;
}

export interface ApiResult {
  status?: number;
  json: unknown;
  setCookies?: readonly string[];
}

export interface RouteOptions<B, Q> {
  auth: "session" | "anonymous" | "public";
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  idempotencyKey?: boolean;
  /** Database rate limits; an "actor" rule may apply only when `when(body)` holds. */
  rateLimits?: readonly RouteRateLimit<B>[];
  /** The sign-in route only: a pre-session (random) CSRF token is accepted. */
  preSessionCsrf?: boolean;
  /** Public routes only: the Cache-Control of a success (PUBLIC_CACHE when absent). */
  publicCache?: typeof PUBLIC_CACHE | typeof PUBLIC_SHORT_CACHE;
}

export interface RouteRateLimit<B> {
  rule: RateRule;
  when?: (body: B) => boolean;
}

export type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string | string[] | undefined>> },
) => Promise<Response>;

const EMPTY = z.strictObject({});

export function route<B = Record<string, never>, Q = Record<string, never>>(
  options: RouteOptions<B, Q>,
  fn: (ctx: RouteContext<B, Q>) => Promise<ApiResult>,
): RouteHandler {
  return async (request, context) => {
    const publicRoute = options.auth === "public";
    const errorCache = publicRoute ? "no-store" : PRIVATE_CACHE;
    try {
      const { appOrigin, trustedProxyHops } = env();
      const unsafe = UNSAFE.has(request.method.toUpperCase());
      if (unsafe) checkCsrf(request, appOrigin);
      const limits = options.rateLimits ?? [];
      for (const { rule } of limits.filter((l) => l.rule.by === "address")) {
        await enforceRate(rule, clientAddress(request, trustedProxyHops));
      }

      const cookieSessionId = publicRoute ? null : readSessionId(request, appOrigin);
      let session: SessionContext | null = null;
      if (options.auth === "session") {
        if (cookieSessionId === null) throw new DomainError("AUTH_REQUIRED", "Sign in to continue.");
        const actor = await sessionActor(webPool(), { authSessionId: cookieSessionId });
        if (actor === null) throw new DomainError("AUTH_REQUIRED", "Sign in to continue.");
        session = { id: cookieSessionId, actor };
      }
      if (unsafe && !options.preSessionCsrf) {
        const bound = session?.id ?? (options.auth === "anonymous" ? cookieSessionId : null);
        if (bound !== null) checkSessionCsrf(request, bound);
      }

      let idempotencyKey = "";
      if (options.idempotencyKey) {
        const key = request.headers.get("idempotency-key") ?? "";
        if (!UUID.safeParse(key).success) {
          throw new RequestError("VALIDATION_FAILED", "An Idempotency-Key header (UUID) is required.", {
            field: "Idempotency-Key",
          });
        }
        idempotencyKey = key.toLowerCase();
      }

      let body: unknown = {};
      if (unsafe) {
        const parsed = (options.body ?? EMPTY).safeParse(await readJson(request));
        if (!parsed.success) throw validationError(parsed.error);
        body = parsed.data;
      }
      if (session !== null) {
        for (const limit of limits.filter((l) => l.rule.by === "actor")) {
          if (limit.when === undefined || limit.when(body as B))
            await enforceRate(limit.rule, session.actor.userId);
        }
      }
      const url = new URL(request.url);
      const parsedQuery = (options.query ?? z.object({})).safeParse(Object.fromEntries(url.searchParams));
      if (!parsedQuery.success) throw validationError(parsedQuery.error);

      const rawParams = (await context.params) ?? {};
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawParams)) if (typeof v === "string") params[k] = v;

      const result = await fn({
        request,
        body: body as B,
        query: parsedQuery.data as Q,
        params,
        idempotencyKey,
        session: session as SessionContext,
        cookieSessionId,
      });
      const headers = new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": publicRoute ? (options.publicCache ?? PUBLIC_CACHE) : PRIVATE_CACHE,
      });
      for (const cookie of result.setCookies ?? []) headers.append("set-cookie", cookie);
      return new Response(JSON.stringify(result.json), { status: result.status ?? 200, headers });
    } catch (error) {
      return errorResponse(error, errorCache);
    }
  };
}

/** A path id that must be a uuid; anything else is NOT_FOUND (never a database error). */
export function pathId(params: Readonly<Record<string, string>>, name = "id"): string {
  const value = params[name];
  if (value === undefined || !UUID.safeParse(value).success) throw new DomainError("NOT_FOUND", "Not found.");
  return value.toLowerCase();
}
