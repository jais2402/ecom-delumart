/**
 * "server-only" semantics without a dependency: every module under src/server imports this file
 * first, so a server module (and the keys it reads) that ends up in a browser bundle throws as
 * soon as it is evaluated instead of running there. The build also scans the client bundles for
 * secret names and values (scripts/check-client-bundle.mjs).
 */
export function assertServerOnly(scope: { window?: unknown } = globalThis as { window?: unknown }): void {
  if (typeof scope.window !== "undefined") {
    throw new Error("A server-only module was imported into browser code.");
  }
}

assertServerOnly();
