import "./server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The client address for per-address rate limits (fifth security review).
 *
 * X-Forwarded-For is whatever the client sent unless a proxy we trust rewrote it, and Next.js only
 * fills it from the socket when it is absent. So:
 *  - TRUSTED_PROXY_HOPS = 0 (default): the header is ignored entirely. The address is the TCP peer,
 *    stamped onto every incoming request by the server process itself (instrumentation.ts) in the
 *    PEER_HEADER, together with a random per-process token a client cannot know; a request without
 *    a valid stamp has the address "unknown" (one shared, strictly limited bucket).
 *  - TRUSTED_PROXY_HOPS = n > 0: n proxies we run each append the address they saw, so the client is
 *    the n-th entry from the right; anything to the left of it is client-supplied and ignored.
 */
export const PEER_HEADER = "x-delulu-peer";
export const UNKNOWN_ADDRESS = "unknown";

const STAMP_KEY = Symbol.for("delulu.peerStampToken");

/** The per-process token of the peer stamp (created on first use, shared through globalThis). */
export function peerStampToken(): string {
  const holder = globalThis as unknown as Record<symbol, string | undefined>;
  holder[STAMP_KEY] ??= randomBytes(24).toString("base64url");
  return holder[STAMP_KEY];
}

/** The PEER_HEADER value for a socket's remote address (the server stamps it; tests imitate it). */
export function peerStampValue(remoteAddress: string): string {
  return `${peerStampToken()} ${remoteAddress}`;
}

const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/;

function plausible(address: string | undefined): string | null {
  if (address === undefined) return null;
  const trimmed = address.trim();
  return ADDRESS.test(trimmed) ? trimmed.toLowerCase() : null;
}

function stampedPeer(headers: Headers): string | null {
  const value = headers.get(PEER_HEADER);
  if (value === null) return null;
  const space = value.indexOf(" ");
  if (space < 0) return null;
  const token = Buffer.from(value.slice(0, space));
  const expected = Buffer.from(peerStampToken());
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) return null;
  return plausible(value.slice(space + 1));
}

export function clientAddress(request: Request, trustedProxyHops: number): string {
  const peer = stampedPeer(request.headers) ?? UNKNOWN_ADDRESS;
  if (trustedProxyHops <= 0) return peer;
  const hops = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (hops.length < trustedProxyHops) return peer;
  return plausible(hops[hops.length - trustedProxyHops]) ?? peer;
}

/** Mutable view of Node's IncomingMessage headers (node:http), without importing node:http types here. */
type NodeHeaders = Record<string, string | string[] | undefined>;

/** Called by the server for every incoming request: replaces any client-sent PEER_HEADER. */
export function stampPeerHeader(headers: NodeHeaders, remoteAddress: string | undefined): void {
  if (remoteAddress === undefined) delete headers[PEER_HEADER];
  else headers[PEER_HEADER] = peerStampValue(remoteAddress);
}

/**
 * The key a client address is rate-limited under (sixth security review, minor 10): an IPv4 address
 * as it is (an IPv4-mapped IPv6 address becomes its IPv4 address); an IPv6 address by its /64
 * prefix, since one host typically holds a whole /64 and could otherwise use a fresh address per
 * request. Anything unparseable is returned unchanged (it is still hashed before storage).
 */
export function rateAddressKey(address: string): string {
  const a = address.trim().toLowerCase();
  if (!a.includes(":")) return a;
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped?.[1]) return mapped[1];
  const hextets = expandIpv6(a);
  if (hextets === null) return a;
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

/**
 * The address prefix that analytics' place minimum counts (eighth review, minor 3c): an IPv4
 * address by its /24 and an IPv6 address by its /48, so one person with many user agents or many
 * addresses of one network still counts once. Anything else is returned as given.
 */
export function placeAddressPrefix(address: string): string {
  const a = rateAddressKey(address);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(a);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  const v6 = /^([0-9a-f]{4}):([0-9a-f]{4}):([0-9a-f]{4}):[0-9a-f]{4}::\/64$/.exec(a);
  if (v6) return `${v6[1]}:${v6[2]}:${v6[3]}::/48`;
  return a;
}

function expandIpv6(a: string): string[] | null {
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const part = (s: string | undefined): string[] => (s === undefined || s === "" ? [] : s.split(":"));
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => h.padStart(4, "0"));
}
