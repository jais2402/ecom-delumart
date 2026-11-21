import { describe, expect, it } from "vitest";
import {
  clearedSessionCookie,
  cookieNames,
  csrfCookie,
  isLocalHttpOrigin,
  readCookie,
  readSessionId,
  sessionCookie,
} from "./session";

const SID = "0192f6a0-1234-7000-8000-00000000abcd";

describe("session cookie (LLD §11.1)", () => {
  it("US-01: on https it is __Host-dm_session, HttpOnly, Secure, SameSite=Lax, Path=/ and has no Domain", () => {
    const cookie = sessionCookie(SID, "https://delulumart.example", 3600);
    expect(cookie.startsWith(`__Host-dm_session=${SID};`)).toBe(true);
    const attrs = cookie.split("; ").slice(1);
    expect(attrs).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=3600"]),
    );
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("US-01: only http://localhost falls back to dm_session without Secure", () => {
    expect(isLocalHttpOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalHttpOrigin("http://localhost")).toBe(true);
    expect(isLocalHttpOrigin("https://localhost:3000")).toBe(false);
    expect(isLocalHttpOrigin("http://127.0.0.1:3000")).toBe(false);
    expect(isLocalHttpOrigin("http://delulumart.example")).toBe(false);
    const cookie = sessionCookie(SID, "http://localhost:3000", 3600);
    expect(cookie.startsWith(`dm_session=${SID};`)).toBe(true);
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookieNames("http://localhost:3000")).toEqual({ session: "dm_session", csrf: "dm_csrf" });
    expect(cookieNames("https://delulumart.example")).toEqual({
      session: "__Host-dm_session",
      csrf: "__Host-dm_csrf",
    });
  });

  it("US-01: sign-out clears the cookie with the same name and attributes", () => {
    const cleared = clearedSessionCookie("https://delulumart.example");
    expect(cleared.startsWith("__Host-dm_session=;")).toBe(true);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
  });

  it("the CSRF cookie is HttpOnly too (the token travels in the response body)", () => {
    const cookie = csrfCookie("tok", "https://delulumart.example", 60);
    expect(cookie.startsWith("__Host-dm_csrf=tok;")).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("reads only the configured cookie name and only a uuid session id", () => {
    const req = (cookie: string) => new Request("https://delulumart.example/", { headers: { cookie } });
    expect(readSessionId(req(`a=1; __Host-dm_session=${SID}; b=2`), "https://delulumart.example")).toBe(SID);
    expect(readSessionId(req(`dm_session=${SID}`), "https://delulumart.example")).toBeNull();
    expect(readSessionId(req("__Host-dm_session=not-a-uuid"), "https://delulumart.example")).toBeNull();
    expect(readSessionId(req(`dm_session=${SID}`), "http://localhost:3000")).toBe(SID);
    expect(readCookie(req("x=%41b"), "x")).toBe("Ab");
    expect(readCookie(new Request("https://x.example/"), "x")).toBeNull();
  });
});
