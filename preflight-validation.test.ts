import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents.js";
import { preflightValidateInvocations } from "./index.js";
import type { AgentInvocation } from "./invocation.js";
import type {
	ModelCatalogPort,
	ResolvedModelConfig,
} from "./model-resolution.js";
import type { SubagentThinkingLevel } from "./model-normalize.js";

function fakeModel(id: string, provider = "provider"): Model<Api> {
	return {
		id,
		provider,
		api: "openai-responses",
		reasoning: true,
	} as Model<Api>;
}

function makeInvocation(
	agentName: string,
	resolvedModel: ResolvedModelConfig,
): AgentInvocation {
	const agent: AgentConfig = {
		name: agentName,
		description: `${agentName} description`,
		systemPrompt: "system prompt",
		source: "bundled",
		filePath: `/tmp/${agentName}.md`,
	};

	return {
		agent,
		agentName,
		promptKind: "task",
		prompt: "Task: test",
		display: "test",
		resolvedModel,
	};
}

function resolved(
	model: string | undefined,
	overrides: Partial<ResolvedModelConfig> = {},
): ResolvedModelConfig {
	return {
		model,
		modelSource: model === undefined ? "parent" : "task",
		source: model === undefined ? "parent" : "task",
		...overrides,
	};
}

function fakeCatalog(options: {
	models?: Model<Api>[];
	available?: (model: Model<Api>) => boolean;
	supported?: SubagentThinkingLevel[];
} = {}) {
	const models = options.models ?? [];
	const findExact = vi.fn((provider: string | undefined, id: string) =>
		provider === undefined
			? undefined
			: models.find((model) => model.provider === provider && model.id === id),
	);
	const resolvePattern = vi.fn((_pattern: string) => undefined);
	const isAvailable = vi.fn(
		(model: Model<Api>) => options.available?.(model) ?? true,
	);
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

describe("preflightValidateInvocations", () => {
	it("passes when every resolved model is valid", () => {
		const first = fakeModel("first", "provider-a");
		const second = fakeModel("second", "provider-b");
		const catalog = fakeCatalog({ models: [first, second] });
		const invocations = [
			makeInvocation("scout", resolved("provider-a/first")),
			makeInvocation(
				"executor",
				resolved("provider-b/second", {
					thinkingLevel: "high",
					thinkingLevelSource: "task",
				}),
			),
		];

		expect(() =>
			preflightValidateInvocations(invocations, catalog.port),
		).not.toThrow();
		expect(catalog.findExact.mock.calls).toEqual([
			["provider-a", "first"],
			["provider-b", "second"],
		]);
	});

	it("throws the first actionable error and does not check a later chain step", () => {
		const valid = fakeModel("valid");
		const catalog = fakeCatalog({ models: [valid] });
		const invocations = [
			makeInvocation("step-1", resolved("provider/valid")),
			makeInvocation("step-2", resolved("provider/missing-step-2")),
			makeInvocation("step-3", resolved("provider/missing-step-3")),
		];

		expect(() =>
			preflightValidateInvocations(invocations, catalog.port),
		).toThrowError(
			'Model "provider/missing-step-2" is not available for agent "step-2". Run /agent-model step-2 to choose an available model.',
		);
		expect(catalog.findExact.mock.calls).toEqual([
			["provider", "valid"],
			["provider", "missing-step-2"],
		]);
	});

	it("reports the supported levels for an unsupported reasoning level", () => {
		const catalog = fakeCatalog({
			models: [fakeModel("reasoning")],
			supported: ["off", "low", "medium"],
		});
		const invocation = makeInvocation(
			"planner",
			resolved("provider/reasoning", {
				thinkingLevel: "max",
				thinkingLevelSource: "task",
			}),
		);

		expect(() =>
			preflightValidateInvocations([invocation], catalog.port),
		).toThrowError(
			'Reasoning level "max" is not supported by "provider/reasoning". Supported: off, low, medium.',
		);
	});

	it("does not consult the catalog for an undefined resolved model", () => {
		const catalog = fakeCatalog();
		const invocation = makeInvocation("inherited", resolved(undefined));

		expect(() =>
			preflightValidateInvocations([invocation], catalog.port),
		).not.toThrow();
		expect(catalog.findExact).not.toHaveBeenCalled();
		expect(catalog.resolvePattern).not.toHaveBeenCalled();
		expect(catalog.isAvailable).not.toHaveBeenCalled();
		expect(catalog.supportedThinkingLevels).not.toHaveBeenCalled();
	});

	it("validates each invocation's agent name with its own resolved model", () => {
		const first = fakeModel("one", "alpha");
		const catalog = fakeCatalog({ models: [first] });
		const invocations = [
			makeInvocation("first-agent", resolved("alpha/one")),
			makeInvocation("second-agent", resolved("beta/two")),
		];

		expect(() =>
			preflightValidateInvocations(invocations, catalog.port),
		).toThrowError(
			'Model "beta/two" is not available for agent "second-agent". Run /agent-model second-agent to choose an available model.',
		);
		expect(catalog.findExact.mock.calls).toEqual([
			["alpha", "one"],
			["beta", "two"],
		]);
	});
});
