/**
 * A minimal browser for calling route handlers directly: a cookie jar, the CSRF token, and the
 * same-origin Origin header on state-changing requests (each can be left out or replaced to test
 * the guards).
 */
import { randomInt, randomUUID } from "node:crypto";
import { PEER_HEADER, peerStampValue } from "../../src/server/client-address";
import type { RouteHandler } from "../../src/server/http";
import { APP_ORIGIN } from "./app";

export interface CallOptions {
  body?: unknown;
  /** Raw body text instead of JSON (with its own content type). */
  rawBody?: { text: string; contentType: string };
  params?: Record<string, string>;
  headers?: Record<string, string>;
  /** false: send no CSRF header; a string: send that token instead. */
  csrf?: boolean | string;
  /** null: no Origin header; a string: that Origin. */
  origin?: string | null;
  /** true: a fresh UUID; a string: that key. */
  idempotencyKey?: boolean | string;
  /** false: send no cookies. */
  cookies?: boolean;
}

/** A documentation-range address (RFC 3849, 2001:db8::/32) for a new browser. */
function testAddress(): string {
  const group = () => randomInt(0x10000).toString(16);
  return `2001:db8:${group()}:${group()}::${group()}`;
}

export interface CallResult {
  status: number;
  headers: Headers;
  text: string;
  json: JsonView;
}

/** A parsed JSON body, indexable in assertions (values are checked with expect, never trusted). */
export interface JsonView {
  readonly [key: string]: JsonView;
}

/** A JSON value that must be a string (an id from an earlier response). */
export function str(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

/** A JSON array, for iterating in assertions. */
export function arr(value: unknown): JsonView[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value as JsonView[];
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class Browser {
  readonly jar = new Map<string, string>();
  csrfToken: string | null = null;
  /** Every response body this browser saw, for leak assertions. */
  readonly seen: string[] = [];
  /**
   * The TCP peer address the server sees for this browser. The test stamps it exactly as the
   * server process does for a real connection (instrumentation.ts); null sends no stamp.
   */
  peer: string | null = testAddress();

  async call(
    handler: RouteHandler,
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<CallResult> {
    const headers = new Headers(options.headers);
    if (this.peer !== null) headers.set(PEER_HEADER, peerStampValue(this.peer));
    if (options.cookies !== false && this.jar.size > 0) {
      headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    let body: string | undefined;
    if (options.rawBody) {
      body = options.rawBody.text;
      headers.set("content-type", options.rawBody.contentType);
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }
    if (UNSAFE.has(method)) {
      const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
      if (origin !== null) headers.set("origin", origin);
      const token = options.csrf === undefined || options.csrf === true ? this.csrfToken : options.csrf;
      if (typeof token === "string") headers.set("x-csrf-token", token);
    }
    if (options.idempotencyKey) {
      headers.set("idempotency-key", options.idempotencyKey === true ? randomUUID() : options.idempotencyKey);
    }
    const request = new Request(new URL(path, APP_ORIGIN), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = "", ...attrs] = cookie.split("; ");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (attrs.includes("Max-Age=0") || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await response.text();
    this.seen.push(text);
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: (text ? JSON.parse(text) : {}) as JsonView,
    };
  }

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }
}
