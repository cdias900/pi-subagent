import { describe, it, expect } from "vitest";
import * as hostAi from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevelsCompat } from "./model-resolution.js";

/**
 * Contract test: the extension must run safely against the REAL host SDK
 * that pi 0.82.1 bundles (`@earendil-works/pi-ai/compat`), not just the
 * pinned `@mariozechner/pi-ai@0.56.1` devDependency. vitest.host.config.ts
 * aliases `@mariozechner/pi-ai` to that compat entry so `model-resolution.ts`
 * resolves the same bindings the real extension loads.
 *
 * Regression this guards: 0.56.1 exports `supportsXhigh`; the host compat
 * entry removed it (replaced by `getSupportedThinkingLevels`). A static
 * `import { supportsXhigh }` becomes `undefined` at runtime and throws
 * `TypeError: supportsXhigh is not a function` for any reasoning model with
 * `thinkingLevelMap == null` — 540 of 1109 real models.
 */

function collectRealCatalog(): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const provider of getBuiltinProviders()) {
		const providerModels = getBuiltinModels(provider);
		for (const model of providerModels) {
			models.push(model as unknown as Model<Api>);
		}
	}
	return models;
}

describe("host SDK contract — @earendil-works/pi-ai/compat", () => {
	it("exposes the modern thinking-level API the extension prefers", () => {
		// The extension relies on this symbol existing on the host module.
		expect(typeof (hostAi as unknown as { getSupportedThinkingLevels?: unknown }).getSupportedThinkingLevels).toBe(
			"function",
		);
	});

	it("does not expose the legacy supportsXhigh symbol (regression source)", () => {
		// Documenting why the static import is unsafe: the host removed it.
		expect(typeof (hostAi as unknown as { supportsXhigh?: unknown }).supportsXhigh).not.toBe(
			"function",
		);
	});

	it("loads a non-empty real model catalog (>1000 models)", () => {
		const catalog = collectRealCatalog();
		// Guard against a vacuous loop. The 0.82.1 catalog has 1109 models.
		expect(catalog.length).toBeGreaterThan(1000);
	});

	it("getSupportedThinkingLevelsCompat does not throw for any real model", () => {
		const catalog = collectRealCatalog();
		expect(catalog.length).toBeGreaterThan(1000);

		const failing: string[] = [];
		for (const model of catalog) {
			try {
				const levels = getSupportedThinkingLevelsCompat(model);
				// Sanity: must be an array of canonical levels.
				expect(Array.isArray(levels)).toBe(true);
			} catch (err) {
				const id = (model as unknown as { id?: string }).id ?? "<unknown>";
				const provider = (model as unknown as { provider?: string }).provider ?? "<unknown>";
				failing.push(`${provider}/${id}: ${(err as Error).message}`);
			}
		}

		expect(failing).toEqual([]);
	});

	it("returns a subset of canonical thinking levels for a known reasoning model", () => {
		const catalog = collectRealCatalog();
		const sonnet = catalog.find(
			(m) =>
				(m as unknown as { id?: string }).id === "claude-sonnet-4-5" &&
				(m as unknown as { provider?: string }).provider === "anthropic",
		);
		expect(sonnet).toBeDefined();
		const levels = getSupportedThinkingLevelsCompat(sonnet as Model<Api>);
		expect(Array.isArray(levels)).toBe(true);
		expect(levels.length).toBeGreaterThan(0);
		// Every returned level must be a canonical level.
		for (const level of levels) {
			expect(level).toMatch(/^(off|minimal|low|medium|high|xhigh|max)$/);
		}
	});
});
