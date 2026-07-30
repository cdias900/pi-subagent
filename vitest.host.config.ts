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

/**
 * Mirror the real pi 0.82.1 extension loader, which force-aliases
 * `@mariozechner/pi-ai` to its bundled `@earendil-works/pi-ai/compat`
 * entry. That entry does NOT export `supportsXhigh` (removed upstream;
 * the replacement is `getSupportedThinkingLevels`). Pointing the alias at
 * the `compat` subpath makes the contract test exercise the exact same
 * bindings the extension loads at real runtime.
 */
const hostCompat = resolve(
	__dirname,
	"node_modules/@earendil-works/pi-ai/dist/compat.js",
);

export default defineConfig({
	plugins: [resolveJsToTs()],
	resolve: {
		alias: {
			"@mariozechner/pi-ai": hostCompat,
		},
	},
	test: {
		include: ["./host-sdk-contract.test.ts"],
	},
});
