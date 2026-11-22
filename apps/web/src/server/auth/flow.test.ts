import { createHash, randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clearedFlowCookie, flowCookie } from "../session";
import { challengeS256, emailBinding, newPkce, openFlow, type SignInFlow, sealFlow } from "./flow";

const key = randomBytes(32);
const NOW = 1_800_000_000_000;

function flow(overrides: Partial<SignInFlow> = {}): SignInFlow {
  return {
    kind: "email",
    state: randomBytes(32).toString("base64url"),
    verifier: newPkce().verifier,
    returnTo: "/p/moon-lamp",
    emailBinding: emailBinding(key, "player@example.test"),
    expiresAt: NOW + 900_000,
    ...overrides,
  };
}

describe("US-01: the sign-in flow (PKCE and the flow cookie)", () => {
  it("PKCE: a 43-character verifier and its S256 challenge (RFC 7636)", () => {
    const { verifier, challenge } = newPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    // known answer, computed independently: printf '%s' <verifier> | openssl dgst -sha256 -binary | base64url
    expect(challengeS256("dBjftJeZ4CVP-mJ0kNwBf1hTxAU3b5XwECa7WxcwEFE")).toBe(
      "xe5ANRGpzdcvludRrZf89kEBfURFeKzUs55wG7tt8C0",
    );
    expect(newPkce().verifier).not.toBe(verifier);
  });

  it("the flow round-trips sealed, and is refused when expired, altered or sealed with another key", () => {
    const f = flow();
    const sealed = sealFlow(key, f);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    // nothing readable in the cookie
    expect(sealed).not.toContain(f.state);
    expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain("moon-lamp");
    expect(openFlow(key, sealed, NOW)).toEqual(f);
    expect(openFlow(key, sealed, f.expiresAt + 1)).toBeNull();
    expect(openFlow(randomBytes(32), sealed, NOW)).toBeNull();
    expect(openFlow(key, "", NOW)).toBeNull();
    expect(openFlow(key, "not base64!", NOW)).toBeNull();
  });

  it("any change to the sealed value is refused (property)", () => {
    const sealed = sealFlow(key, flow());
    fc.assert(
      fc.property(fc.nat({ max: sealed.length - 1 }), (i) => {
        const c = sealed[i] === "A" ? "B" : "A";
        const tampered = `${sealed.slice(0, i)}${c}${sealed.slice(i + 1)}`;
        const opened = openFlow(key, tampered, NOW);
        // a change in the last character's unused bits may decode to the same bytes; anything else fails
        if (opened !== null)
          expect(Buffer.from(tampered, "base64url")).toEqual(Buffer.from(sealed, "base64url"));
      }),
      { numRuns: 200 },
    );
  });

  it("the email binding is keyed and normalised by the caller; it differs per address and key", () => {
    expect(emailBinding(key, "a@example.test")).toBe(emailBinding(key, "a@example.test"));
    expect(emailBinding(key, "a@example.test")).not.toBe(emailBinding(key, "b@example.test"));
    expect(emailBinding(randomBytes(32), "a@example.test")).not.toBe(emailBinding(key, "a@example.test"));
    expect(emailBinding(key, "a@example.test")).not.toContain("example");
  });

  it("the flow cookie: __Host- prefixed, HttpOnly, SameSite=Lax, Secure, short-lived; cleared with Max-Age=0", () => {
    const c = flowCookie("abc", "https://delulu.example", 900);
    expect(c).toBe("__Host-dm_auth_flow=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=900; Secure");
    expect(clearedFlowCookie("https://delulu.example")).toMatch(
      /^__Host-dm_auth_flow=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0;/,
    );
    expect(flowCookie("abc", "http://localhost:3000", 900)).toBe(
      "dm_auth_flow=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=900",
    );
  });
});
