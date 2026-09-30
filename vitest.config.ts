import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";

/**
 * Narrowly remap relative source imports ending in `.js` to their `.ts`
 * source file when the literal `.js` file does not exist on disk.
 *
 * Scope is intentionally limited:
 *  - Only relative specifiers (`./` or `../`) are considered.
 *  - Only specifiers whose extension is exactly `.js`.
 *  - The real `.js` file always wins if it exists.
 *  - Bare / package imports (node_modules) are never rewritten.
 *
 * This lets Vitest/Vite resolve the NodeNext-style `.js` import specifiers
 * used by this project's TypeScript sources to the corresponding `.ts` files
 * without altering how third-party packages are resolved.
 */
function resolveJsToTs() {
  return {
    name: "resolve-js-to-ts",
    enforce: "pre" as const,
    resolveId(source: string, importer: string | undefined) {
      if (!importer) return null;
      if (!source.startsWith("./") && !source.startsWith("../")) return null;
      if (extname(source) !== ".js") return null;

      const importerDir = dirname(importer);
      const jsPath = resolve(importerDir, source);
      if (existsSync(jsPath)) return null;

      const tsPath = jsPath.slice(0, -".js".length) + ".ts";
      if (existsSync(tsPath)) return tsPath;

      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolveJsToTs()],
  // Match Pi's host module aliases; never test against an older physical SDK copy.
  resolve: {
    alias: [
      { find: "@mariozechner/pi-coding-agent", replacement: resolve(__dirname, "node_modules/@earendil-works/pi-coding-agent/dist/index.js") },
      { find: "@mariozechner/pi-agent-core", replacement: resolve(__dirname, "node_modules/@earendil-works/pi-agent-core/dist/index.js") },
      { find: "@mariozechner/pi-ai", replacement: resolve(__dirname, "node_modules/@earendil-works/pi-ai/dist/compat.js") },
      { find: "@mariozechner/pi-tui", replacement: resolve(__dirname, "node_modules/@earendil-works/pi-tui/dist/index.js") },
      { find: /^@sinclair\/typebox$/, replacement: resolve(__dirname, "node_modules/typebox/build/index.mjs") },
      { find: /^@sinclair\/typebox\/(.*)$/, replacement: resolve(__dirname, "node_modules/typebox/build/$1/index.mjs") },
    ],
  },
  test: {
    include: ["**/*.test.ts"],
    // The host SDK contract has its own focused command/config, but both suites
    // now resolve the same current SDK and AI compat exports.
    exclude: ["**/node_modules/**", "./host-sdk-contract.test.ts"],
  },
});
