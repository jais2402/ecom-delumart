import { describe, expect, it } from "vitest";
import {
  clientAddress,
  PEER_HEADER,
  peerStampValue,
  rateAddressKey,
  stampPeerHeader,
  UNKNOWN_ADDRESS,
} from "./client-address";

function req(headers: Record<string, string>): Request {
  return new Request("https://app.delulu.test/api/v1/x", { headers });
}

describe("clientAddress (fifth security review: rate limits trust only a trusted source)", () => {
  it("TRUSTED_PROXY_HOPS=0: X-Forwarded-For and X-Real-IP are ignored; the stamped peer address is used", () => {
    const peer = peerStampValue("198.51.100.7");
    for (const xff of ["203.0.113.1", "203.0.113.1, 203.0.113.2", "1.1.1.1, 2.2.2.2, 3.3.3.3"]) {
      expect(
        clientAddress(req({ "x-forwarded-for": xff, "x-real-ip": "9.9.9.9", [PEER_HEADER]: peer }), 0),
      ).toBe("198.51.100.7");
    }
  });

  it("a peer header the client made up (no valid stamp token) is no address at all", () => {
    for (const forged of ["198.51.100.7", "x 198.51.100.7", `${"a".repeat(32)} 198.51.100.7`]) {
      expect(clientAddress(req({ [PEER_HEADER]: forged }), 0)).toBe(UNKNOWN_ADDRESS);
    }
    expect(clientAddress(req({ "x-forwarded-for": "203.0.113.1" }), 0)).toBe(UNKNOWN_ADDRESS);
  });

  it("TRUSTED_PROXY_HOPS=n: the n-th address from the right; client-supplied entries to its left are ignored", () => {
    const peer = peerStampValue("10.0.0.2");
    const h = (xff: string) => req({ "x-forwarded-for": xff, [PEER_HEADER]: peer });
    expect(clientAddress(h("evil, 203.0.113.5"), 1)).toBe("203.0.113.5");
    expect(clientAddress(h("1.2.3.4, 5.6.7.8, 203.0.113.5"), 1)).toBe("203.0.113.5");
    expect(clientAddress(h("1.2.3.4, 203.0.113.5, 10.0.0.9"), 2)).toBe("203.0.113.5");
    // fewer entries than trusted hops, or garbage: the peer
    expect(clientAddress(h("203.0.113.5"), 2)).toBe("10.0.0.2");
    expect(clientAddress(h("not an address"), 1)).toBe("10.0.0.2");
    expect(clientAddress(req({ [PEER_HEADER]: peer }), 1)).toBe("10.0.0.2");
  });

  it("the server's stamp replaces whatever the client sent in the peer header", () => {
    const headers: Record<string, string | string[] | undefined> = { [PEER_HEADER]: "forged 1.2.3.4" };
    stampPeerHeader(headers, "::ffff:127.0.0.1");
    expect(clientAddress(req({ [PEER_HEADER]: String(headers[PEER_HEADER]) }), 0)).toBe("::ffff:127.0.0.1");
    stampPeerHeader(headers, undefined);
    expect(headers[PEER_HEADER]).toBeUndefined();
  });
});

describe("rateAddressKey (sixth security review, minor 10)", () => {
  it("US-01: IPv6 addresses of one /64 share one key; another /64 has its own", () => {
    const a = rateAddressKey("2001:db8:1234:5678::1");
    expect(a).toBe("2001:0db8:1234:5678::/64");
    expect(rateAddressKey("2001:db8:1234:5678:abcd:ef01:2345:6789")).toBe(a);
    expect(rateAddressKey("2001:0DB8:1234:5678:ffff::")).toBe(a);
    expect(rateAddressKey("2001:db8:1234:5679::1")).not.toBe(a);
    expect(rateAddressKey("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("US-01: IPv4 stays per address, including IPv4-mapped IPv6", () => {
    expect(rateAddressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(rateAddressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateAddressKey("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateAddressKey("unknown")).toBe("unknown");
    expect(rateAddressKey("2001:db8::1::2")).toBe("2001:db8::1::2");
  });
});
