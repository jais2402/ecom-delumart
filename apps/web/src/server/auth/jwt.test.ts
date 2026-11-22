import { createHmac, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JwksCache } from "./jwks";
import { verifyAccessToken } from "./jwt";

const ISSUER = "https://abcdefghijklmnopqrst.supabase.co/auth/v1";
const NOW = 1_800_000_000_000;

interface Signer {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function signer(kid: string = randomUUID()): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(NOW / 1000);
  return {
    iss: ISSUER,
    aud: "authenticated",
    sub: randomUUID(),
    session_id: randomUUID(),
    role: "authenticated",
    iat,
    exp: iat + 3600,
    email: "player@example.test",
    is_anonymous: false,
    ...overrides,
  };
}

function token(s: Signer, payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const head = b64({ alg: "ES256", typ: "JWT", kid: s.kid, ...header });
  const body = b64(payload);
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), {
    key: s.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${sig.toString("base64url")}`;
}

/** A JWKS server stand-in: counts fetches, can fail. */
function jwksSource(initial: Signer[]) {
  const state = { keys: initial, down: false, fetches: 0, now: NOW };
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    state.fetches += 1;
    expect(String(url)).toBe("https://abcdefghijklmnopqrst.supabase.co/auth/v1/.well-known/jwks.json");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (state.down) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const cache = new JwksCache({
    url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/.well-known/jwks.json",
    fetch: fetchImpl as typeof fetch,
    now: () => state.now,
    ttlMs: 600_000,
    minRefetchMs: 30_000,
    timeoutMs: 1_000,
    maxBytes: 65_536,
  });
  return { state, cache };
}

const options = (cache: JwksCache, nowMs = NOW) => ({
  jwks: cache,
  issuer: ISSUER,
  audience: "authenticated",
  nowMs,
  skewSeconds: 30,
  maxBytes: 8192,
});

describe("US-01: Supabase access token verification (ES256, JWKS)", () => {
  it("accepts a valid ES256 token and returns its user and session ids", async () => {
    const k = signer();
    const { cache } = jwksSource([k]);
    const c = claims();
    const result = await verifyAccessToken(token(k, c), options(cache));
    expect(result).toEqual({
      ok: true,
      claims: { sub: c.sub, sessionId: c.session_id, email: "player@example.test" },
    });
  });

  it("refuses HS256 (even signed with the public key as an HMAC secret) and alg none", async () => {
    const k = signer();
    const { cache } = jwksSource([k]);
    const head = b64({ alg: "HS256", typ: "JWT", kid: k.kid });
    const body = b64(claims());
    const hmac = createHmac("sha256", JSON.stringify(k.jwk)).update(`${head}.${body}`).digest("base64url");
    expect(await verifyAccessToken(`${head}.${body}.${hmac}`, options(cache))).toEqual({
      ok: false,
      reason: "ALG",
    });
    const none = `${b64({ alg: "none", typ: "JWT", kid: k.kid })}.${body}.`;
    expect(await verifyAccessToken(none, options(cache))).toEqual({ ok: false, reason: "ALG" });
    for (const alg of ["ES384", "RS256", "es256", "ES256 "]) {
      expect(await verifyAccessToken(token(k, claims(), { alg }), options(cache))).toEqual({
        ok: false,
        reason: "ALG",
      });
    }
  });

  it("refuses an unknown kid and a token signed by another project's key with a known kid", async () => {
    const k = signer();
    const other = signer(k.kid); // same kid, different key: another project
    const { cache } = jwksSource([k]);
    expect(await verifyAccessToken(token(signer(), claims()), options(cache))).toEqual({
      ok: false,
      reason: "KEY",
    });
    expect(await verifyAccessToken(token(other, claims()), options(cache))).toEqual({
      ok: false,
      reason: "SIGNATURE",
    });
  });

  it("refuses expired tokens and tokens not valid yet, within a small skew", async () => {
    const k = signer();
    const { cache } = jwksSource([k]);
    const now = Math.floor(NOW / 1000);
    expect(await verifyAccessToken(token(k, claims({ exp: now - 31 })), options(cache))).toEqual({
      ok: false,
      reason: "EXPIRED",
    });
    expect((await verifyAccessToken(token(k, claims({ exp: now - 10 })), options(cache))).ok).toBe(true);
    expect(await verifyAccessToken(token(k, claims({ nbf: now + 60 })), options(cache))).toEqual({
      ok: false,
      reason: "NOT_YET_VALID",
    });
    expect(await verifyAccessToken(token(k, claims({ iat: now + 120 })), options(cache))).toEqual({
      ok: false,
      reason: "NOT_YET_VALID",
    });
    expect(await verifyAccessToken(token(k, claims({ exp: undefined })), options(cache))).toEqual({
      ok: false,
      reason: "CLAIMS",
    });
  });

  it("refuses a wrong issuer or audience, a non-user role, an anonymous user, and missing ids", async () => {
    const k = signer();
    const { cache } = jwksSource([k]);
    const bad = async (o: Record<string, unknown>) =>
      (await verifyAccessToken(token(k, claims(o)), options(cache))).ok;
    expect(
      await verifyAccessToken(token(k, claims({ iss: "https://evil.supabase.co/auth/v1" })), options(cache)),
    ).toEqual({
      ok: false,
      reason: "ISSUER",
    });
    expect(await verifyAccessToken(token(k, claims({ aud: "anon" })), options(cache))).toEqual({
      ok: false,
      reason: "AUDIENCE",
    });
    expect(
      (await verifyAccessToken(token(k, claims({ aud: ["x", "authenticated"] })), options(cache))).ok,
    ).toBe(true);
    expect(await bad({ role: "service_role" })).toBe(false);
    expect(await bad({ role: "anon" })).toBe(false);
    expect(await bad({ is_anonymous: true })).toBe(false);
    expect(await bad({ session_id: undefined })).toBe(false);
    expect(await bad({ sub: "not-a-uuid" })).toBe(false);
  });

  it("refuses any change to a signed token (property)", async () => {
    const k = signer();
    const { cache } = jwksSource([k]);
    const good = token(k, claims());
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: good.length - 1 }), fc.integer({ min: 1, max: 60 }), async (i, d) => {
        const ch = good.charCodeAt(i);
        const replacement = String.fromCharCode(((ch - 33 + d) % 94) + 33);
        fc.pre(replacement !== good[i]);
        const tampered = `${good.slice(0, i)}${replacement}${good.slice(i + 1)}`;
        expect((await verifyAccessToken(tampered, options(cache))).ok).toBe(false);
      }),
      { numRuns: 150 },
    );
  });

  it("refuses oversized and malformed tokens without fetching", async () => {
    const k = signer();
    const { cache, state } = jwksSource([k]);
    for (const t of ["", "a.b", "a.b.c.d", `${"x".repeat(9000)}.y.z`, "%%%.%%%.%%%"]) {
      expect((await verifyAccessToken(t, options(cache))).ok).toBe(false);
    }
    expect(state.fetches).toBe(0);
  });
});

describe("US-01: the JWKS cache", () => {
  it("caches keys by kid, re-reads on an unknown kid at most once per interval (key rotation)", async () => {
    const a = signer();
    const { cache, state } = jwksSource([a]);
    expect((await verifyAccessToken(token(a, claims()), options(cache))).ok).toBe(true);
    expect((await verifyAccessToken(token(a, claims()), options(cache))).ok).toBe(true);
    expect(state.fetches).toBe(1);
    // the project rotates to a new key: the first token with the new kid triggers one re-read
    const b = signer();
    state.keys = [a, b];
    state.now += 31_000;
    expect((await verifyAccessToken(token(b, claims()), options(cache, state.now))).ok).toBe(true);
    expect(state.fetches).toBe(2);
    // a flood of unknown kids does not hammer the JWKS endpoint
    for (let i = 0; i < 20; i++)
      await verifyAccessToken(token(signer(), claims()), options(cache, state.now));
    expect(state.fetches).toBe(2);
  });

  it("a key removed from the JWKS stops working once the cache is re-read (revocation)", async () => {
    const a = signer();
    const b = signer();
    const { cache, state } = jwksSource([a, b]);
    expect((await verifyAccessToken(token(a, claims()), options(cache))).ok).toBe(true);
    state.keys = [b];
    state.now += 600_001;
    expect(await verifyAccessToken(token(a, claims()), options(cache, state.now))).toEqual({
      ok: false,
      reason: "KEY",
    });
  });

  it("fails closed: JWKS unreachable with no fresh key means no sign-in", async () => {
    const a = signer();
    const { cache, state } = jwksSource([a]);
    state.down = true;
    expect(await verifyAccessToken(token(a, claims()), options(cache))).toEqual({ ok: false, reason: "KEY" });
    state.down = false;
    state.now += 31_000;
    expect((await verifyAccessToken(token(a, claims()), options(cache, state.now))).ok).toBe(true);
    // cached keys expire: an outage after the TTL refuses again
    state.down = true;
    state.now += 600_001;
    expect(await verifyAccessToken(token(a, claims()), options(cache, state.now))).toEqual({
      ok: false,
      reason: "KEY",
    });
  });

  it("ignores keys that are not P-256 signing keys", async () => {
    const a = signer();
    const odd = { ...signer().jwk, kid: "rsa-ish", crv: "P-384" };
    const enc = { ...signer().jwk, kid: "enc", use: "enc" };
    const hs = { kty: "oct", kid: "hs", k: "c2VjcmV0", alg: "HS256" };
    const { cache, state } = jwksSource([a]);
    state.keys = [
      a,
      { kid: "rsa-ish", privateKey: a.privateKey, jwk: odd },
      { kid: "enc", privateKey: a.privateKey, jwk: enc },
      { kid: "hs", privateKey: a.privateKey, jwk: hs },
    ];
    expect(await cache.key("rsa-ish")).toBeNull();
    expect(await cache.key("enc")).toBeNull();
    expect(await cache.key("hs")).toBeNull();
    expect(await cache.key(a.kid)).not.toBeNull();
  });
});
