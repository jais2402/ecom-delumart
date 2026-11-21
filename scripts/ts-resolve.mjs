// Lets `node --experimental-strip-types` run the workspace's TypeScript sources, whose relative
// imports omit the extension ("./account", "./card/index") as the bundler resolution allows.
// Tries "<specifier>.ts" and "<specifier>/index.ts" when the plain specifier is not found.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // try the next form
        }
      }
      throw error;
    }
  },
});
