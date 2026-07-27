import { describe, expect, it } from "vitest";
import {
	CANONICAL_THINKING_LEVELS,
	isThinkingLevel,
	normalizeModelString,
	splitProviderModel,
	type SubagentThinkingLevel,
} from "./model-normalize.js";

const EXPECTED_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

const TYPED_THINKING_LEVELS: readonly SubagentThinkingLevel[] = [
	...EXPECTED_THINKING_LEVELS,
];

describe("model normalization", () => {
	it("defines the seven canonical thinking levels in order", () => {
		expect(CANONICAL_THINKING_LEVELS).toEqual(EXPECTED_THINKING_LEVELS);
	});

	it("accepts every canonical level as a SubagentThinkingLevel", () => {
		expect(TYPED_THINKING_LEVELS).toEqual(CANONICAL_THINKING_LEVELS);
	});

	it("recognizes only canonical thinking levels", () => {
		const candidates = [
			...EXPECTED_THINKING_LEVELS,
			"reasoning",
			"none",
			"",
		];
		const accepted: SubagentThinkingLevel[] = candidates.filter(isThinkingLevel);

		expect(accepted).toEqual(EXPECTED_THINKING_LEVELS);
	});

	it("splits provider/model on the first slash", () => {
		expect(splitProviderModel("openrouter/anthropic/claude-sonnet-4")).toEqual({
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-4",
		});
		expect(splitProviderModel("claude-sonnet-4")).toEqual({
			provider: undefined,
			modelId: "claude-sonnet-4",
		});
	});

	it.each([
		["provider/model:high", "provider/model", "provider", "model", "high"],
		["openai/gpt-5.6-sol:max", "openai/gpt-5.6-sol", "openai", "gpt-5.6-sol", "max"],
		["provider/model:off", "provider/model", "provider", "model", "off"],
		[
			"openrouter/anthropic/claude-sonnet-4:high",
			"openrouter/anthropic/claude-sonnet-4",
			"openrouter",
			"anthropic/claude-sonnet-4",
			"high",
		],
	] as const)("normalizes %s", (input, base, provider, modelId, thinkingLevel) => {
		expect(normalizeModelString(input)).toEqual({ base, provider, modelId, thinkingLevel });
	});

	it("leaves a model without a thinking-level suffix unchanged", () => {
		expect(normalizeModelString("provider/model")).toEqual({
			base: "provider/model",
			provider: "provider",
			modelId: "model",
			thinkingLevel: undefined,
		});
	});

	it("preserves non-level colons", () => {
		expect(normalizeModelString("openrouter/model:exacto")).toEqual({
			base: "openrouter/model:exacto",
			provider: "openrouter",
			modelId: "model:exacto",
			thinkingLevel: undefined,
		});
	});

	it("normalizes bare model ids", () => {
		expect(normalizeModelString("claude-sonnet-4")).toEqual({
			base: "claude-sonnet-4",
			provider: undefined,
			modelId: "claude-sonnet-4",
			thinkingLevel: undefined,
		});
		expect(normalizeModelString("model:high")).toEqual({
			base: "model",
			provider: undefined,
			modelId: "model",
			thinkingLevel: "high",
		});
	});
});
