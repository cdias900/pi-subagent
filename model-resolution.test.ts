import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	getSupportedThinkingLevelsCompat,
	resolveModelLayers,
	validateResolvedModel,
	type ModelCatalogPort,
	type ResolvedModelConfig,
} from "./model-resolution.js";
import type { SubagentThinkingLevel } from "./model-normalize.js";

describe("resolveModelLayers", () => {
	it("returns the parent source defaults when no layers or parent are supplied", () => {
		expect(resolveModelLayers({ layers: [] })).toEqual({
			model: undefined,
			thinkingLevel: undefined,
			modelSource: "parent",
			thinkingLevelSource: undefined,
			source: "parent",
		});
	});

	it("folds the parent model and thinking level as the lowest layer", () => {
		expect(
			resolveModelLayers({
				layers: [],
				parent: { model: "openai/parent", thinkingLevel: "medium" },
			}),
		).toEqual({
			model: "openai/parent",
			thinkingLevel: "medium",
			modelSource: "parent",
			thinkingLevelSource: "parent",
			source: "parent",
		});
	});

	it("resets the parent thinking level for a frontmatter model-only layer", () => {
		expect(
			resolveModelLayers({
				parent: { model: "openai/parent", thinkingLevel: "high" },
				layers: [{ model: "anthropic/child", source: "frontmatter" }],
			}),
		).toEqual({
			model: "anthropic/child",
			thinkingLevel: undefined,
			modelSource: "frontmatter",
			thinkingLevelSource: undefined,
			source: "frontmatter",
		});
	});

	it("normalizes a frontmatter model suffix into its thinking level", () => {
		expect(
			resolveModelLayers({
				layers: [{ model: "openai/gpt-5.3:high", source: "frontmatter" }],
			}),
		).toEqual({
			model: "openai/gpt-5.3",
			thinkingLevel: "high",
			modelSource: "frontmatter",
			thinkingLevelSource: "frontmatter",
			source: "frontmatter",
		});
	});

	it("lets a global model replace the frontmatter model and reset thinking", () => {
		expect(
			resolveModelLayers({
				layers: [
					{
						model: "anthropic/frontmatter",
						thinkingLevel: "high",
						source: "frontmatter",
					},
					{ model: "openai/global", source: "global" },
				],
			}),
		).toEqual({
			model: "openai/global",
			thinkingLevel: undefined,
			modelSource: "global",
			thinkingLevelSource: undefined,
			source: "global",
		});
	});

	it("lets session thinking retain a lower frontmatter model", () => {
		expect(
			resolveModelLayers({
				layers: [
					{ model: "anthropic/frontmatter", source: "frontmatter" },
					{ thinkingLevel: "medium", source: "session" },
				],
			}),
		).toEqual({
			model: "anthropic/frontmatter",
			thinkingLevel: "medium",
			modelSource: "frontmatter",
			thinkingLevelSource: "session",
			source: "frontmatter",
		});
	});

	it("lets a separate field beat a lower model suffix", () => {
		expect(
			resolveModelLayers({
				layers: [
					{ model: "openai/gpt-5.3:high", source: "frontmatter" },
					{ thinkingLevel: "max", source: "session" },
				],
			}),
		).toMatchObject({
			model: "openai/gpt-5.3",
			thinkingLevel: "max",
			modelSource: "frontmatter",
			thinkingLevelSource: "session",
			source: "frontmatter",
		});
	});

	it("lets a layer's separate thinking field beat its own suffix", () => {
		expect(
			resolveModelLayers({
				layers: [
					{
						model: "openai/gpt-5.3:high",
						thinkingLevel: "low",
						source: "task",
					},
				],
			}),
		).toMatchObject({
			model: "openai/gpt-5.3",
			thinkingLevel: "low",
			modelSource: "task",
			thinkingLevelSource: "task",
			source: "task",
		});
	});

	it("lets an invocation-wide model replace a global model", () => {
		expect(
			resolveModelLayers({
				layers: [
					{ model: "openai/global", source: "global" },
					{ model: "anthropic/invocation", source: "invocation" },
				],
			}),
		).toMatchObject({
			model: "anthropic/invocation",
			modelSource: "invocation",
			source: "invocation",
		});
	});

	it("folds the full parent-to-task precedence ladder from low to high", () => {
		expect(
			resolveModelLayers({
				parent: { model: "provider/parent", thinkingLevel: "minimal" },
				layers: [
					{
						model: "provider/frontmatter",
						thinkingLevel: "low",
						source: "frontmatter",
					},
					{
						model: "provider/global",
						thinkingLevel: "medium",
						source: "global",
					},
					{
						model: "provider/session",
						thinkingLevel: "high",
						source: "session",
					},
					{
						model: "provider/invocation",
						thinkingLevel: "xhigh",
						source: "invocation",
					},
					{
						model: "provider/task",
						thinkingLevel: "max",
						source: "task",
					},
				],
			}),
		).toEqual({
			model: "provider/task",
			thinkingLevel: "max",
			modelSource: "task",
			thinkingLevelSource: "task",
			source: "task",
		});
	});

	it("resets thinking when a higher model-only layer follows any lower level", () => {
		expect(
			resolveModelLayers({
				parent: { model: "provider/parent", thinkingLevel: "xhigh" },
				layers: [
					{ thinkingLevel: "max", source: "session" },
					{ model: "provider/task", source: "task" },
				],
			}),
		).toEqual({
			model: "provider/task",
			thinkingLevel: undefined,
			modelSource: "task",
			thinkingLevelSource: undefined,
			source: "task",
		});
	});

	it("applies a thinking-only session layer to the parent model", () => {
		expect(
			resolveModelLayers({
				parent: { model: "openai/parent", thinkingLevel: "low" },
				layers: [{ thinkingLevel: "high", source: "session" }],
			}),
		).toEqual({
			model: "openai/parent",
			thinkingLevel: "high",
			modelSource: "parent",
			thinkingLevelSource: "session",
			source: "session",
		});
	});

	it("keeps a thinking-only layer when neither it nor the parent supplies a model", () => {
		expect(
			resolveModelLayers({
				layers: [{ thinkingLevel: "off", source: "session" }],
			}),
		).toEqual({
			model: undefined,
			thinkingLevel: "off",
			modelSource: "parent",
			thinkingLevelSource: "session",
			source: "session",
		});
	});

	it.each([
		{
			name: "pure parent",
			input: {
				parent: { model: "provider/parent", thinkingLevel: "medium" as const },
				layers: [],
			},
			expected: ["parent", "parent", "parent"],
		},
		{
			name: "parent with higher thinking",
			input: {
				parent: { model: "provider/parent", thinkingLevel: "medium" as const },
				layers: [{ thinkingLevel: "high" as const, source: "invocation" as const }],
			},
			expected: ["parent", "invocation", "invocation"],
		},
		{
			name: "non-parent model with higher thinking",
			input: {
				layers: [
					{ model: "provider/frontmatter", source: "frontmatter" as const },
					{ thinkingLevel: "high" as const, source: "task" as const },
				],
			},
			expected: ["frontmatter", "task", "frontmatter"],
		},
	])(
		"computes modelSource, thinkingLevelSource, and source for $name",
		({ input, expected }) => {
			const resolved = resolveModelLayers(input);
			expect([
				resolved.modelSource,
				resolved.thinkingLevelSource,
				resolved.source,
			]).toEqual(expected);
		},
	);

	it.each([
		["empty string", ""],
		["whitespace-only", "  \t "],
	])(
		"throws for an explicit %s model on a layer instead of silently skipping",
		(_label, model) => {
			expect(() =>
				resolveModelLayers({
					layers: [{ model, source: "frontmatter" }],
				}),
			).toThrow(
				'model from source "frontmatter" must not be empty or whitespace-only',
			);
		},
	);

	it("does not silently inherit a lower-precedence model when a higher layer supplies an explicit empty model", () => {
		expect(() =>
			resolveModelLayers({
				parent: { model: "openai/parent", thinkingLevel: "high" },
				layers: [
					{ model: "anthropic/frontmatter", source: "frontmatter" },
					{ model: "", source: "global" },
				],
			}),
		).toThrow(
			'model from source "global" must not be empty or whitespace-only',
		);
	});
});

interface FakeCatalogOptions {
	exact?: Model<Api>;
	pattern?: Model<Api>;
	available?: boolean;
	supported?: SubagentThinkingLevel[];
}

function fakeModel(id = "model", provider = "provider"): Model<Api> {
	return {
		id,
		provider,
		api: "openai-responses",
		reasoning: true,
	} as Model<Api>;
}

function fakeCatalog(options: FakeCatalogOptions = {}) {
	const findExact = vi.fn(
		(_provider: string | undefined, _id: string) => options.exact,
	);
	const resolvePattern = vi.fn((_pattern: string) => options.pattern);
	const isAvailable = vi.fn((_model: Model<Api>) => options.available ?? true);
	const supportedThinkingLevels = vi.fn(
		(_model: Model<Api>) =>
			options.supported ??
			(["off", "minimal", "low", "medium", "high"] as SubagentThinkingLevel[]),
	);
	const port: ModelCatalogPort = {
		findExact,
		resolvePattern,
		isAvailable,
		supportedThinkingLevels,
	};

	return {
		port,
		findExact,
		resolvePattern,
		isAvailable,
		supportedThinkingLevels,
	};
}

function resolved(
	overrides: Partial<ResolvedModelConfig> = {},
): ResolvedModelConfig {
	return {
		model: "provider/model",
		modelSource: "task",
		source: "task",
		...overrides,
	};
}

const NEW_EXACT_SOURCES = ["global", "session", "invocation", "task"] as const;

describe("validateResolvedModel", () => {
	it("accepts an undefined model without consulting the catalog", () => {
		const catalog = fakeCatalog();

		expect(
			validateResolvedModel(
				resolved({ model: undefined, modelSource: "parent", source: "parent" }),
				catalog.port,
				{ agentName: "scout" },
			),
		).toEqual({ ok: true });
		expect(catalog.findExact).not.toHaveBeenCalled();
		expect(catalog.resolvePattern).not.toHaveBeenCalled();
	});

	it.each(NEW_EXACT_SOURCES)(
		"rejects a missing exact %s model with actionable context",
		(modelSource) => {
			const catalog = fakeCatalog();
			const result = validateResolvedModel(
				resolved({
					model: "openrouter/anthropic/claude-sonnet",
					modelSource,
					source: modelSource,
				}),
				catalog.port,
				{ agentName: "reviewer" },
			);

			expect(catalog.findExact).toHaveBeenCalledWith(
				"openrouter",
				"anthropic/claude-sonnet",
			);
			expect(result).toMatchObject({ ok: false });
			if (!result.ok) {
				expect(result.error).toContain("openrouter/anthropic/claude-sonnet");
				expect(result.error).toContain("reviewer");
				expect(result.error).toContain("/agent-model");
			}
		},
	);

	it.each(NEW_EXACT_SOURCES)(
		"rejects an unavailable exact %s model with actionable context",
		(modelSource) => {
			const selected = fakeModel();
			const catalog = fakeCatalog({ exact: selected, available: false });
			const result = validateResolvedModel(
				resolved({ modelSource, source: modelSource }),
				catalog.port,
				{ agentName: "executor" },
			);

			expect(catalog.isAvailable).toHaveBeenCalledWith(selected);
			expect(result).toMatchObject({ ok: false });
			if (!result.ok) {
				expect(result.error).toContain("provider/model");
				expect(result.error).toContain("executor");
				expect(result.error).toContain("/agent-model");
			}
		},
	);

	it("resolves a frontmatter model through the public pattern resolver", () => {
		const selected = fakeModel("claude-sonnet", "anthropic");
		const catalog = fakeCatalog({ pattern: selected });

		expect(
			validateResolvedModel(
				resolved({
					model: "sonnet",
					modelSource: "frontmatter",
					source: "frontmatter",
				}),
				catalog.port,
				{ agentName: "scout" },
			),
		).toEqual({ ok: true, model: selected });
		expect(catalog.resolvePattern).toHaveBeenCalledWith("sonnet");
		expect(catalog.findExact).not.toHaveBeenCalled();
	});

	it("falls back to an exact lookup after frontmatter pattern resolution misses", () => {
		const selected = fakeModel("claude-sonnet", "anthropic");
		const catalog = fakeCatalog({ exact: selected });

		expect(
			validateResolvedModel(
				resolved({
					model: "anthropic/claude-sonnet",
					modelSource: "frontmatter",
					source: "frontmatter",
				}),
				catalog.port,
				{ agentName: "scout" },
			),
		).toEqual({ ok: true, model: selected });
		expect(catalog.resolvePattern).toHaveBeenCalledWith(
			"anthropic/claude-sonnet",
		);
		expect(catalog.findExact).toHaveBeenCalledWith(
			"anthropic",
			"claude-sonnet",
		);
	});

	it.each([
		{
			name: "no thinking level",
			thinkingLevel: undefined,
			thinkingLevelSource: undefined,
		},
		{
			name: "legacy frontmatter suffix",
			thinkingLevel: "high" as const,
			thinkingLevelSource: "frontmatter" as const,
		},
	])("passes through unresolved frontmatter with $name", (override) => {
		const catalog = fakeCatalog();

		expect(
			validateResolvedModel(
				resolved({
					model: "legacy-sonnet-pattern",
					modelSource: "frontmatter",
					thinkingLevel: override.thinkingLevel,
					thinkingLevelSource: override.thinkingLevelSource,
					source: "frontmatter",
				}),
				catalog.port,
				{ agentName: "legacy-agent" },
			),
		).toEqual({ ok: true });
	});

	it.each(["global", "session", "invocation", "task"] as const)(
		"rejects unresolved frontmatter when %s explicitly overrides thinking",
		(thinkingLevelSource) => {
			const catalog = fakeCatalog();
			const result = validateResolvedModel(
				resolved({
					model: "legacy-sonnet-pattern",
					modelSource: "frontmatter",
					thinkingLevel: "high",
					thinkingLevelSource,
					source: "frontmatter",
				}),
				catalog.port,
				{ agentName: "legacy-agent" },
			);

			expect(result).toMatchObject({ ok: false });
			if (!result.ok) {
				expect(result.error).toContain("legacy-sonnet-pattern");
				expect(result.error).toContain("legacy-agent");
				expect(result.error).toContain("/agent-model");
			}
		},
	);

	it("validates an exact, available parent model and its supported level", () => {
		const selected = fakeModel("parent", "openai");
		const catalog = fakeCatalog({
			exact: selected,
			supported: ["off", "medium", "high"],
		});

		expect(
			validateResolvedModel(
				resolved({
					model: "openai/parent",
					modelSource: "parent",
					thinkingLevel: "medium",
					thinkingLevelSource: "parent",
					source: "parent",
				}),
				catalog.port,
				{ agentName: "planner" },
			),
		).toEqual({ ok: true, model: selected });
		expect(catalog.findExact).toHaveBeenCalledWith("openai", "parent");
		expect(catalog.isAvailable).toHaveBeenCalledWith(selected);
		expect(catalog.supportedThinkingLevels).toHaveBeenCalledWith(selected);
	});

	it.each([undefined, "parent"] as const)(
		"trusts an unresolved pure parent model with thinking source %s",
		(thinkingLevelSource) => {
			const catalog = fakeCatalog();

			expect(
				validateResolvedModel(
					resolved({
						model: "runtime/parent",
						modelSource: "parent",
						thinkingLevel: thinkingLevelSource ? "high" : undefined,
						thinkingLevelSource,
						source: "parent",
					}),
					catalog.port,
					{ agentName: "planner" },
				),
			).toEqual({ ok: true });
		},
	);

	it.each([undefined, "parent"] as const)(
		"trusts an unavailable pure parent model with thinking source %s",
		(thinkingLevelSource) => {
			const selected = fakeModel("parent", "runtime");
			const catalog = fakeCatalog({ exact: selected, available: false });

			expect(
				validateResolvedModel(
					resolved({
						model: "runtime/parent",
						modelSource: "parent",
						thinkingLevel: thinkingLevelSource ? "high" : undefined,
						thinkingLevelSource,
						source: "parent",
					}),
					catalog.port,
					{ agentName: "planner" },
				),
			).toEqual({ ok: true, model: selected });
		},
	);

	it("rejects an unresolved parent model with a higher explicit thinking override", () => {
		const catalog = fakeCatalog();
		const result = validateResolvedModel(
			resolved({
				model: "runtime/parent",
				modelSource: "parent",
				thinkingLevel: "max",
				thinkingLevelSource: "session",
				source: "session",
			}),
			catalog.port,
			{ agentName: "planner" },
		);

		expect(result).toMatchObject({ ok: false });
		if (!result.ok) {
			expect(result.error).toContain("runtime/parent");
			expect(result.error).toContain("planner");
			expect(result.error).toContain("/agent-model");
		}
	});

	it("rejects an unavailable parent model with a higher explicit thinking override", () => {
		const selected = fakeModel("parent", "runtime");
		const catalog = fakeCatalog({ exact: selected, available: false });
		const result = validateResolvedModel(
			resolved({
				model: "runtime/parent",
				modelSource: "parent",
				thinkingLevel: "max",
				thinkingLevelSource: "task",
				source: "task",
			}),
			catalog.port,
			{ agentName: "planner" },
		);

		expect(result).toMatchObject({ ok: false });
		if (!result.ok) {
			expect(result.error).toContain("runtime/parent");
			expect(result.error).toContain("planner");
			expect(result.error).toContain("/agent-model");
		}
	});

	it("rejects an unsupported higher thinking override on the parent model", () => {
		const selected = fakeModel("parent", "openai");
		const catalog = fakeCatalog({
			exact: selected,
			supported: ["off", "low", "medium", "high"],
		});
		const result = validateResolvedModel(
			resolved({
				model: "openai/parent",
				modelSource: "parent",
				thinkingLevel: "max",
				thinkingLevelSource: "invocation",
				source: "invocation",
			}),
			catalog.port,
			{ agentName: "planner" },
		);

		expect(result).toEqual({
			ok: false,
			error:
				'Reasoning level "max" is not supported by "openai/parent". Supported: off, low, medium, high.',
		});
	});

	it("lists the model's supported levels when rejecting a level", () => {
		const selected = fakeModel();
		const catalog = fakeCatalog({
			exact: selected,
			supported: ["off", "minimal", "low", "high", "xhigh"],
		});

		expect(
			validateResolvedModel(
				resolved({
					thinkingLevel: "max",
					thinkingLevelSource: "task",
				}),
				catalog.port,
				{ agentName: "executor" },
			),
		).toEqual({
			ok: false,
			error:
				'Reasoning level "max" is not supported by "provider/model". Supported: off, minimal, low, high, xhigh.',
		});
	});

	it("accepts a supported level and returns the catalog model", () => {
		const selected = fakeModel();
		const catalog = fakeCatalog({ exact: selected, supported: ["off", "max"] });

		expect(
			validateResolvedModel(
				resolved({
					thinkingLevel: "max",
					thinkingLevelSource: "task",
				}),
				catalog.port,
				{ agentName: "executor" },
			),
		).toEqual({ ok: true, model: selected });
	});
});

interface RuntimeModelLiteral {
	id: string;
	api: Api;
	reasoning: boolean;
	thinkingLevelMap?:
		| Partial<Record<SubagentThinkingLevel, string | null | undefined>>
		| null;
}

function runtimeModel(literal: RuntimeModelLiteral): Model<Api> {
	return literal as unknown as Model<Api>;
}

describe("getSupportedThinkingLevelsCompat", () => {
	it("returns only off for a non-reasoning model", () => {
		expect(
			getSupportedThinkingLevelsCompat(
				runtimeModel({
					id: "non-reasoning",
					api: "openai-responses",
					reasoning: false,
					thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				}),
			),
		).toEqual(["off"]);
	});

	it("mirrors runtime thinkingLevelMap null and extended-level semantics", () => {
		expect(
			getSupportedThinkingLevelsCompat(
				runtimeModel({
					id: "mapped-reasoning",
					api: "openai-responses",
					reasoning: true,
					thinkingLevelMap: {
						off: null,
						minimal: null,
						low: "low",
						high: null,
						xhigh: "xhigh",
						max: "max",
					},
				}),
			),
		).toEqual(["low", "medium", "xhigh", "max"]);
	});

	it("treats an empty runtime map as standard levels only", () => {
		expect(
			getSupportedThinkingLevelsCompat(
				runtimeModel({
					id: "empty-map",
					api: "openai-responses",
					reasoning: true,
					thinkingLevelMap: {},
				}),
			),
		).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it.each([
		{
			id: "ordinary-model",
			expected: ["off", "minimal", "low", "medium", "high"],
		},
		{
			id: "gpt-5.3-codex",
			expected: ["off", "minimal", "low", "medium", "high", "xhigh"],
		},
	])("treats a null runtime map as the map-less fallback for $id", ({ id, expected }) => {
		const levels = getSupportedThinkingLevelsCompat(
			runtimeModel({
				id,
				api: "openai-responses",
				reasoning: true,
				thinkingLevelMap: null,
			}),
		);

		expect(levels).toEqual(expected);
		expect(levels).not.toContain("max");
	});

	it("uses the conservative standard-level fallback for an ordinary map-less model", () => {
		const levels = getSupportedThinkingLevelsCompat(
			runtimeModel({
				id: "ordinary-model",
				api: "openai-responses",
				reasoning: true,
			}),
		);

		expect(levels).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(levels).not.toContain("max");
	});

	it.each([
		{ id: "gpt-5.3-codex", api: "openai-responses" as Api },
		{ id: "claude-opus-4.6", api: "anthropic-messages" as Api },
	])("adds xhigh for a map-less public supportsXhigh model: $id", ({ id, api }) => {
		const levels = getSupportedThinkingLevelsCompat(
			runtimeModel({ id, api, reasoning: true }),
		);

		expect(levels).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(levels).not.toContain("max");
	});

	it("does not add xhigh to an ordinary map-less model", () => {
		expect(
			getSupportedThinkingLevelsCompat(
				runtimeModel({
					id: "gpt-4.1",
					api: "openai-responses",
					reasoning: true,
				}),
			),
		).not.toContain("xhigh");
	});
});
