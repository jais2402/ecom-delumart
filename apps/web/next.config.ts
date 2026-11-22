import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "geolocation=(), camera=(), microphone=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const config: NextConfig = {
  transpilePackages: ["@delulu/ui", "@delulu/core", "@delulu/db"],
  // pnpm monorepo: trace server files from the repository root, so the workspace packages
  // (@delulu/core, @delulu/db, @delulu/ui) and their dependencies are part of every function on
  // Vercel (Root Directory apps/web).
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  poweredByHeader: false,
  // next dev would otherwise write apps/web/AGENTS.md on every start
  agentRules: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
