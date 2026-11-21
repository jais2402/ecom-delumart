/**
 * Runs once when the server starts: parse the configuration so a bad or missing variable stops the
 * server with a clear message instead of failing on the first request. Skipped while building.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { env } = await import("./server/env");
  env();
}
