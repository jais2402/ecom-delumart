import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";
import { contentSecurityPolicy, isPrivatePage, PRIVATE_PAGE_PREFIXES } from "./server/page-headers";

const APP = fileURLToPath(new URL("./app", import.meta.url));
const ORIGIN = "https://app.delulu.test";

/** Every page.tsx under src/app, as a URL path (route groups dropped, [params] filled in). */
function pageRoutes(): { path: string; files: string[] }[] {
  const out: { path: string; files: string[] }[] = [];
  const walk = (dir: string, layouts: string[]): void => {
    const here = readdirSync(dir);
    const chain = here.includes("layout.tsx") ? [...layouts, join(dir, "layout.tsx")] : layouts;
    if (here.includes("page.tsx")) {
      const segments = relative(APP, dir)
        .split(sep)
        .filter((s) => s !== "" && !/^\(.*\)$/.test(s))
        .map((s) => (s.startsWith("[") ? "0192f6a0-0000-7000-8000-0000000000ff" : s));
      out.push({ path: `/${segments.join("/")}`, files: [...chain, join(dir, "page.tsx")] });
    }
    for (const entry of here) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory() && entry !== "api" && !entry.startsWith("_")) walk(full, chain);
    }
  };
  walk(APP, []);
  return out;
}

const PRIVATE_SECTIONS = new Set(["account", "cart", "checkout", "orders", "onboarding", "sign-in", "sell"]);

function run(path: string, env = "production") {
  const saved = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = env;
  try {
    return proxy(new NextRequest(new URL(path, ORIGIN)));
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = saved;
  }
}

describe("page headers (fifth security review: CSP and private page caching)", () => {
  const routes = pageRoutes();

  it("the route list covers every private section", () => {
    const sections = new Set(routes.map((r) => r.path.split("/")[1]));
    for (const s of PRIVATE_SECTIONS) expect(sections.has(s), s).toBe(true);
    expect(routes.length).toBeGreaterThanOrEqual(15);
  });

  it.each(pageRoutes())(
    "$path: CSP with a fresh nonce; private, no-store exactly when it is a private section",
    ({ path, files }) => {
      const a = run(path);
      const b = run(path);
      const csp = a.headers.get("content-security-policy") ?? "";
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
      expect(nonce.length).toBeGreaterThanOrEqual(22);
      expect(b.headers.get("content-security-policy")).not.toBe(csp);
      expect(csp).toBe(contentSecurityPolicy(nonce, false));
      // the renderer receives the same policy (it reads the nonce from it)
      expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
      const isPrivate = PRIVATE_SECTIONS.has(path.split("/")[1] ?? "");
      expect(isPrivatePage(path)).toBe(isPrivate);
      expect(a.headers.get("cache-control")).toBe(isPrivate ? "private, no-store" : null);
      if (isPrivate) {
        // and it is rendered per request, never prerendered into a shared shell
        expect(
          files.some((f) => /export const dynamic = "force-dynamic"/.test(readFileSync(f, "utf8"))),
          path,
        ).toBe(true);
      }
    },
  );

  it("the production policy: nonce scripts only, nothing inline or eval, no framing, no plugins, no base or foreign forms", () => {
    const csp = contentSecurityPolicy("AAAAAAAAAAAAAAAAAAAAAA==", false);
    const d = Object.fromEntries(
      csp.split("; ").map((x) => [x.split(" ")[0], x.split(" ").slice(1).join(" ")]),
    );
    expect(d["default-src"]).toBe("'self'");
    expect(d["script-src"]).toBe("'self' 'nonce-AAAAAAAAAAAAAAAAAAAAAA==' 'strict-dynamic'");
    expect(d["style-src"]).toBe("'self' 'nonce-AAAAAAAAAAAAAAAAAAAAAA=='");
    expect(d["img-src"]).toBe("'self' data:");
    expect(d["font-src"]).toBe("'self'");
    expect(d["connect-src"]).toBe("'self'");
    expect(d["frame-ancestors"]).toBe("'none'");
    expect(d["form-action"]).toBe("'self'");
    expect(d["base-uri"]).toBe("'none'");
    expect(d["object-src"]).toBe("'none'");
    expect(csp).not.toMatch(/unsafe-eval|ws:|\*/);
    expect(d["script-src"]).not.toContain("unsafe-inline");
  });

  it("development adds only what the dev server needs (eval for React debugging, the websocket, inline dev styles)", () => {
    const csp = run("/", "development").headers.get("content-security-policy") ?? "";
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(run("/", "production").headers.get("content-security-policy")).not.toContain("unsafe-eval");
  });

  it("the proxy runs on pages, not on API routes or static files", () => {
    const [source] = config.matcher;
    const matches = (p: string) => new RegExp(`^${source}$`).test(p);
    for (const { path } of routes) expect(matches(path), path).toBe(true);
    for (const p of ["/api/v1/me", "/_next/static/chunks/x.js", "/favicon.ico"])
      expect(matches(p), p).toBe(false);
    expect(PRIVATE_PAGE_PREFIXES.length).toBe(PRIVATE_SECTIONS.size);
  });
});
