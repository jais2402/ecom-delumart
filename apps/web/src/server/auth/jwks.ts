import "../server-only";
import { webcrypto } from "node:crypto";

/**
 * The project's signing keys, from Supabase Auth's JWKS (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`),
 * cached by key id. Only P-256 ECDSA verification keys are kept (kty EC, crv P-256, alg ES256 or
 * absent, use sig or absent); anything else in the document is ignored.
 *
 * - The whole set is re-read when it is older than `ttlMs`; a key that left the set stops working
 *   then (a revoked key is not trusted for longer than the TTL).
 * - An unknown key id triggers a re-read (key rotation), at most once per `minRefetchMs`, so a
 *   stream of made-up ids cannot turn into a stream of requests.
 * - Fail closed: when the set cannot be read and the cached one is stale, there are no keys at all
 *   and every token is refused. Timeouts, redirects (refused), non-200 answers, oversized or
 *   malformed bodies all count as "cannot be read".
 */
export interface JwksOptions {
  url: string;
  fetch?: typeof fetch;
  /** Clock in milliseconds (injectable for tests). */
  now?: () => number;
  ttlMs: number;
  minRefetchMs: number;
  timeoutMs: number;
  maxBytes: number;
}

export interface KeySource {
  key(kid: string): Promise<webcrypto.CryptoKey | null>;
}

interface Jwk {
  kty?: unknown;
  crv?: unknown;
  kid?: unknown;
  alg?: unknown;
  use?: unknown;
  x?: unknown;
  y?: unknown;
  key_ops?: unknown;
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

function usable(jwk: Jwk): jwk is Jwk & { kid: string; x: string; y: string } {
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.kid === "string" &&
    jwk.kid.length > 0 &&
    jwk.kid.length <= 200 &&
    (jwk.alg === undefined || jwk.alg === "ES256") &&
    (jwk.use === undefined || jwk.use === "sig") &&
    (jwk.key_ops === undefined || (Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify"))) &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string" &&
    B64URL_32.test(jwk.x) &&
    B64URL_32.test(jwk.y)
  );
}

export class JwksCache implements KeySource {
  private keys = new Map<string, webcrypto.CryptoKey>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: JwksOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async key(kid: string): Promise<webcrypto.CryptoKey | null> {
    const now = this.now();
    const stale = now - this.fetchedAt >= this.options.ttlMs;
    if (stale) {
      // a stale set is never used: re-read (rate-limited) or have nothing
      if (
        now - this.attemptedAt >= this.options.minRefetchMs ||
        this.fetchedAt === Number.NEGATIVE_INFINITY
      ) {
        await this.refresh();
      }
      if (this.now() - this.fetchedAt >= this.options.ttlMs) this.keys.clear();
      return this.keys.get(kid) ?? null;
    }
    const known = this.keys.get(kid);
    if (known) return known;
    if (now - this.attemptedAt >= this.options.minRefetchMs) await this.refresh();
    return this.keys.get(kid) ?? null;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.attemptedAt = this.now();
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      const text = await response.text();
      if (text.length > this.options.maxBytes) throw new Error("too large");
      const body = JSON.parse(text) as { keys?: unknown };
      if (!Array.isArray(body.keys)) throw new Error("no keys");
      const next = new Map<string, webcrypto.CryptoKey>();
      for (const jwk of body.keys as Jwk[]) {
        if (!usable(jwk) || next.has(jwk.kid)) continue;
        const key = await webcrypto.subtle.importKey(
          "jwk",
          { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        next.set(jwk.kid, key);
      }
      this.keys = next;
      this.fetchedAt = this.now();
    } catch (error) {
      // the kind of failure only: a URL or body could carry project details
      console.error("[auth] signing keys unavailable", (error as Error | null)?.name ?? "error");
    }
  }
}
