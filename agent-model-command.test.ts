import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents.js";
import {
	parseAgentModelArgs,
	registerAgentModelCommand,
	type AgentModelCommandDeps,
} from "./agent-model-command.js";
import type {
	AgentModelOverride,
	SubagentModelConfig,
} from "./model-config.js";
import {
	getSupportedThinkingLevelsCompat,
	resolveModelLayers,
	type ModelCatalogPort,
} from "./model-resolution.js";

const CANONICAL_LEVELS = "off, minimal, low, medium, high, xhigh, max";

function fakeAgent(name: string, model?: string): AgentConfig {
	return {
		name,
		description: `${name} description`,
		model,
		systemPrompt: `${name} prompt`,
		source: "bundled",
		filePath: `/agents/${name}.md`,
	};
}

function fakeModel(
	provider: string,
	id: string,
	levels: readonly string[] = ["off", "minimal", "low", "medium", "high"],
): Model<Api> {
	const thinkingLevelMap = Object.fromEntries(
		["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
			(level) => [level, levels.includes(level) ? level : null],
		),
	);

	return {
		provider,
		id,
		name: `${provider}/${id} display name`,
		api: "openai-responses",
		reasoning: levels.some((level) => level !== "off"),
		thinkingLevelMap,
	} as unknown as Model<Api>;
}

function replaceOverride(
	config: SubagentModelConfig,
	agent: string,
	override: AgentModelOverride | undefined,
): SubagentModelConfig {
	const next = { ...config };
	if (override === undefined) delete next[agent];
	else next[agent] = { ...override };
	return next;
}

interface HarnessOptions {
	agents?: AgentConfig[];
	availableModels?: Model<Api>[];
	models?: Model<Api>[];
	global?: SubagentModelConfig;
	session?: SubagentModelConfig;
}

function makeHarness(options: HarnessOptions = {}) {
	const agents = options.agents ?? [fakeAgent("scout"), fakeAgent("executor")];
	const models =
		options.models ??
		[
			fakeModel("provider", "reasoner", [
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"max",
			]),
			fakeModel("provider", "plain", ["off"]),
		];
	const availableModels = options.availableModels ?? models;
	let session = structuredClone(options.session ?? {});
	let global = structuredClone(options.global ?? {});

	const findModel = (provider: string | undefined, id: string) =>
		provider === undefined
			? undefined
			: models.find(
					(model) => model.provider === provider && model.id === id,
				);
	const isAvailable = vi.fn((model: Model<Api>) =>
		availableModels.some(
			(available) =>
				available.provider === model.provider && available.id === model.id,
		),
	);
	const port: ModelCatalogPort = {
		findExact: findModel,
		resolvePattern: () => undefined,
		isAvailable,
		supportedThinkingLevels: getSupportedThinkingLevelsCompat,
	};

	const setSessionOverride = vi.fn(
		(agent: string, override: AgentModelOverride | undefined) => {
			session = replaceOverride(session, agent, override);
		},
	);
	const saveGlobal = vi.fn(
		(agent: string, override: AgentModelOverride) => {
			global = replaceOverride(global, agent, override);
		},
	);
	const resetGlobal = vi.fn((agent: string) => {
		global = replaceOverride(global, agent, undefined);
	});

	const deps: AgentModelCommandDeps = {
		discover: vi.fn(() => agents),
		getSessionOverrides: vi.fn(() => session),
		setSessionOverride,
		loadGlobal: vi.fn(() => ({
			config: global,
			path: "/config/subagent-models.json",
		})),
		saveGlobal,
		resetGlobal,
		makePort: vi.fn(() => port),
		parentFor: vi.fn(() => ({
			model: "provider/parent",
			thinkingLevel: "medium",
		})),
		buildEffectiveConfig: (agent, config) =>
			resolveModelLayers({
				parent: config.parent,
				layers: [
					{ model: agent.model, source: "frontmatter" },
					config.global === undefined
						? undefined
						: { ...config.global, source: "global" },
					config.session === undefined
						? undefined
						: { ...config.session, source: "session" },
				],
			}),
	};

	let handler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	const pi = {
		registerCommand(
			name: string,
			options: {
				handler: (
					args: string,
					ctx: ExtensionCommandContext,
				) => Promise<void>;
			},
		) {
			expect(name).toBe("agent-model");
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerAgentModelCommand(pi, deps);
	expect(handler).toBeDefined();

	return {
		agents,
		availableModels,
		deps,
		handler: handler!,
		models,
		port,
		resetGlobal,
		saveGlobal,
		setSessionOverride,
		getGlobal: () => global,
		getSession: () => session,
		isAvailable,
	};
}

function makeContext(options: {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	models?: Model<Api>[];
	selectResults?: Array<string | undefined>;
	customResults?: Array<string | undefined>;
} = {}) {
	const selectResults = [...(options.selectResults ?? [])];
	const customResults = [...(options.customResults ?? [])];
	const models = options.models ?? [];
	const notify = vi.fn();
	const select = vi.fn(async () => selectResults.shift());
	const custom = vi.fn(async () => customResults.shift());
	const ctx = {
		...(options.mode === undefined ? {} : { mode: options.mode }),
		hasUI: options.hasUI ?? true,
		cwd: "/workspace",
		ui: { notify, select, custom },
		modelRegistry: {
			getAvailable: vi.fn(() => models),
			find: vi.fn((provider: string, id: string) =>
				models.find(
					(model) => model.provider === provider && model.id === id,
				),
			),
		},
	} as unknown as ExtensionCommandContext;

	return { ctx, custom, notify, select };
}

function expectNoWrites(harness: ReturnType<typeof makeHarness>): void {
	expect(harness.setSessionOverride).not.toHaveBeenCalled();
	expect(harness.saveGlobal).not.toHaveBeenCalled();
	expect(harness.resetGlobal).not.toHaveBeenCalled();
}

describe("parseAgentModelArgs", () => {
	it("parses empty and whitespace-only input as the guided flow", () => {
		expect(parseAgentModelArgs("")).toEqual({ kind: "guided" });
		expect(parseAgentModelArgs(" \t\n ")).toEqual({ kind: "guided" });
	});

	it("parses one agent token as the guided flow for that agent", () => {
		expect(parseAgentModelArgs("scout")).toEqual({
			kind: "guidedAgent",
			agent: "scout",
		});
	});

	it("parses session and global direct forms with an optional canonical level", () => {
		expect(
			parseAgentModelArgs(" session  scout  openai/gpt-5.6-sol  max "),
		).toEqual({
			kind: "direct",
			scope: "session",
			agent: "scout",
			model: "openai/gpt-5.6-sol",
			thinkingLevel: "max",
		});
		expect(parseAgentModelArgs("global scout anthropic/sonnet")).toEqual({
			kind: "direct",
			scope: "global",
			agent: "scout",
			model: "anthropic/sonnet",
			thinkingLevel: undefined,
		});
	});

	it("parses session and global reset forms", () => {
		expect(parseAgentModelArgs("session scout reset")).toEqual({
			kind: "reset",
			scope: "session",
			agent: "scout",
		});
		expect(parseAgentModelArgs("global scout reset")).toEqual({
			kind: "reset",
			scope: "global",
			agent: "scout",
		});
	});

	it.each([
		"project scout provider/reasoner",
		"scout extra",
		"session",
		"session scout",
		"global",
		"global scout",
		"session scout provider/reasoner high extra",
		"global scout reset high",
	])("rejects malformed or incomplete form %j with usage", (input) => {
		const parsed = parseAgentModelArgs(input);
		expect(parsed.kind).toBe("error");
		if (parsed.kind === "error") {
			expect(parsed.message).toContain("Usage:");
			expect(parsed.message).toContain("/agent-model session");
			expect(parsed.message).toContain("/agent-model global");
		}
	});

	it("rejects a non-canonical level and lists every valid level", () => {
		const parsed = parseAgentModelArgs(
			"session scout provider/reasoner extreme",
		);
		expect(parsed.kind).toBe("error");
		if (parsed.kind === "error") {
			expect(parsed.message).toContain('Invalid reasoning level "extreme"');
			expect(parsed.message).toContain(CANONICAL_LEVELS);
			expect(parsed.message).toContain("Usage:");
		}
	});
});

describe("registerAgentModelCommand direct forms", () => {
	it("sets only the current-session override", async () => {
		const harness = makeHarness();
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("session scout provider/reasoner max", ctx);

		expect(harness.setSessionOverride).toHaveBeenCalledOnce();
		expect(harness.setSessionOverride).toHaveBeenCalledWith("scout", {
			model: "provider/reasoner",
			thinkingLevel: "max",
		});
		expect(harness.saveGlobal).not.toHaveBeenCalled();
		expect(harness.resetGlobal).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/scout[\s\S]*provider\/reasoner[\s\S]*max[\s\S]*session/i),
			"info",
		);
	});

	it("sets only the global override", async () => {
		const harness = makeHarness();
		const { ctx, notify } = makeContext({ mode: "rpc" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expect(harness.saveGlobal).toHaveBeenCalledOnce();
		expect(harness.saveGlobal).toHaveBeenCalledWith("scout", {
			model: "provider/reasoner",
			thinkingLevel: "high",
		});
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
		expect(harness.resetGlobal).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/scout[\s\S]*provider\/reasoner[\s\S]*high[\s\S]*global/i),
			"info",
		);
	});

	it.each([
		["session", "setSessionOverride"],
		["global", "resetGlobal"],
	] as const)("resets only the %s scope", async (scope, expectedWrite) => {
		const harness = makeHarness({
			session: { scout: { model: "provider/reasoner" } },
			global: { scout: { model: "provider/reasoner" } },
		});
		const { ctx } = makeContext({ mode: "tui" });

		await harness.handler(`${scope} scout reset`, ctx);

		if (expectedWrite === "setSessionOverride") {
			expect(harness.setSessionOverride).toHaveBeenCalledWith(
				"scout",
				undefined,
			);
			expect(harness.resetGlobal).not.toHaveBeenCalled();
		} else {
			expect(harness.resetGlobal).toHaveBeenCalledWith("scout");
			expect(harness.setSessionOverride).not.toHaveBeenCalled();
		}
		expect(harness.saveGlobal).not.toHaveBeenCalled();
	});

	it("rejects an unknown agent before any write", async () => {
		const harness = makeHarness();
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("session missing provider/reasoner high", ctx);

		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/unknown agent.*missing.*scout.*executor/i),
			"error",
		);
	});

	it("rejects an unknown exact provider/model before any write", async () => {
		const harness = makeHarness();
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("session scout provider/missing high", ctx);

		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Model "provider/missing" is not available'),
			"error",
		);
	});

	it("rejects an unavailable or unauthenticated model before any write", async () => {
		const model = fakeModel("provider", "reasoner");
		const harness = makeHarness({ models: [model], availableModels: [] });
		const { ctx, notify } = makeContext({ mode: "rpc" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/unavailable or unauthenticated/i),
			"error",
		);
	});

	it("rejects a level unsupported by the selected model before any write", async () => {
		const plain = fakeModel("provider", "plain", ["off"]);
		const harness = makeHarness({ models: [plain] });
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("session scout provider/plain high", ctx);

		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/Reasoning level "high"[\s\S]*Supported: off/),
			"error",
		);
	});

	it("reports malformed global configuration without mutating either scope", async () => {
		const harness = makeHarness();
		harness.deps.loadGlobal = vi.fn(() => ({
			config: {},
			error: "/config/subagent-models.json: malformed JSON",
			path: "/config/subagent-models.json",
		}));
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("session scout provider/reasoner high", ctx);

		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("malformed JSON"),
			"error",
		);
	});

	it("catches persistence errors without writing the other scope", async () => {
		const harness = makeHarness();
		harness.saveGlobal.mockImplementation(() => {
			throw new Error("disk is read-only");
		});
		const { ctx, notify } = makeContext({ mode: "rpc" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expect(harness.getGlobal()).toEqual({});
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
		expect(harness.resetGlobal).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("disk is read-only"),
			"error",
		);
	});

	it.each(["tui", "rpc"] as const)(
		"supports direct forms in a live %s UI context",
		async (mode) => {
			const harness = makeHarness();
			const { ctx } = makeContext({ mode, hasUI: true });

			await harness.handler("session scout provider/reasoner high", ctx);

			expect(harness.setSessionOverride).toHaveBeenCalledOnce();
		},
	);

	it.each([
		["json", true],
		["print", true],
		[undefined, true],
		["tui", false],
		["rpc", false],
	] as const)(
		"rejects direct forms without a live UI-capable mode (%s, hasUI=%s)",
		async (mode, hasUI) => {
			const harness = makeHarness();
			const { ctx, notify } = makeContext({ mode, hasUI });

			await harness.handler("session scout provider/reasoner high", ctx);

			expectNoWrites(harness);
			expect(notify).toHaveBeenCalledWith(
				expect.stringMatching(/TUI or RPC[\s\S]*model.*thinkingLevel/i),
				"error",
			);
		},
	);
});

describe("registerAgentModelCommand guided flow", () => {
	it("saves an authenticated reasoning model with high only to the current session", async () => {
		const model = fakeModel("provider", "reasoner");
		const harness = makeHarness({ models: [model], availableModels: [model] });
		const { ctx, notify } = makeContext({
			mode: "tui",
			models: [model],
			customResults: ["provider/reasoner"],
			selectResults: ["high", "Current Pi session"],
		});

		await harness.handler("scout", ctx);

		expect(harness.setSessionOverride).toHaveBeenCalledOnce();
		expect(harness.setSessionOverride).toHaveBeenCalledWith("scout", {
			model: "provider/reasoner",
			thinkingLevel: "high",
		});
		expect(harness.saveGlobal).not.toHaveBeenCalled();
		expect(harness.resetGlobal).not.toHaveBeenCalled();
		expect(harness.isAvailable).toHaveBeenCalledOnce();
		expect(harness.isAvailable).toHaveBeenCalledWith(model);
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			'Agent "scout" updated: model provider/reasoner; reasoning high; source session; scope Current Pi session (session).',
			"info",
		);
	});

	it("saves agent-default reasoning without a thinking level to the selected scope", async () => {
		const model = fakeModel("provider", "reasoner");
		const harness = makeHarness({ models: [model], availableModels: [model] });
		const { ctx } = makeContext({
			mode: "tui",
			models: [model],
			customResults: ["provider/reasoner"],
			selectResults: ["Use agent default", "Global default"],
		});

		await harness.handler("scout", ctx);

		expect(harness.saveGlobal).toHaveBeenCalledOnce();
		expect(harness.saveGlobal).toHaveBeenCalledWith("scout", {
			model: "provider/reasoner",
		});
		const savedOverride = harness.saveGlobal.mock.calls[0]?.[1];
		expect(savedOverride).toStrictEqual({ model: "provider/reasoner" });
		expect(savedOverride).not.toHaveProperty("thinkingLevel");
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
		expect(harness.resetGlobal).not.toHaveBeenCalled();
	});

	it("revalidates guided availability before saving the selected scope", async () => {
		const model = fakeModel("provider", "reasoner");
		const harness = makeHarness({ models: [model], availableModels: [] });
		const { ctx, notify } = makeContext({
			mode: "tui",
			models: [model],
			customResults: ["provider/reasoner"],
			selectResults: ["high", "Current Pi session"],
		});

		await harness.handler("scout", ctx);

		expect(harness.isAvailable).toHaveBeenCalledOnce();
		expect(harness.isAvailable).toHaveBeenCalledWith(model);
		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/unavailable or unauthenticated/i),
			"error",
		);
	});

	it.each(["rpc", "json", "print", undefined] as const)(
		"returns actionable direct syntax outside TUI (%s)",
		async (mode) => {
			const harness = makeHarness();
			const { ctx, notify } = makeContext({ mode });

			await harness.handler("scout", ctx);

			expectNoWrites(harness);
			expect(notify).toHaveBeenCalledWith(
				expect.stringMatching(
					/Guided.*TUI[\s\S]*\/agent-model session scout <provider\/model> \[level\][\s\S]*\/agent-model global scout reset/i,
				),
				"warning",
			);
		},
	);

	it("verifies a guided agent exists before opening the picker", async () => {
		const harness = makeHarness();
		const { ctx, custom, notify } = makeContext({ mode: "tui" });

		await harness.handler("missing", ctx);

		expectNoWrites(harness);
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('Unknown agent "missing"'),
			"error",
		);
	});

	it("does not write when the agent stage is cancelled", async () => {
		const harness = makeHarness();
		const { ctx, custom } = makeContext({
			mode: "tui",
			selectResults: [undefined],
		});

		await harness.handler("", ctx);

		expectNoWrites(harness);
		expect(custom).not.toHaveBeenCalled();
	});

	it("does not write when the model stage is cancelled", async () => {
		const harness = makeHarness();
		const { ctx } = makeContext({
			mode: "tui",
			models: harness.availableModels,
			customResults: [undefined],
		});

		await harness.handler("scout", ctx);

		expectNoWrites(harness);
	});

	it("does not write when the reasoning stage is cancelled", async () => {
		const harness = makeHarness();
		const { ctx } = makeContext({
			mode: "tui",
			models: harness.availableModels,
			customResults: ["provider/reasoner"],
			selectResults: [undefined],
		});

		await harness.handler("scout", ctx);

		expectNoWrites(harness);
	});

	it("does not write when the scope stage is cancelled", async () => {
		const harness = makeHarness();
		const { ctx } = makeContext({
			mode: "tui",
			models: harness.availableModels,
			customResults: ["provider/reasoner"],
			selectResults: ["high", undefined],
		});

		await harness.handler("scout", ctx);

		expectNoWrites(harness);
	});

	it("does not write when default is selected and the scope stage is cancelled", async () => {
		const harness = makeHarness();
		const { ctx, select } = makeContext({
			mode: "tui",
			models: harness.availableModels,
			customResults: ["__default__"],
			selectResults: [undefined],
		});

		await harness.handler("scout", ctx);

		expectNoWrites(harness);
		expect(select).toHaveBeenCalledOnce();
	});

	it("skips reasoning and clears only the selected scope for agent default", async () => {
		const harness = makeHarness({
			session: { scout: { model: "provider/reasoner" } },
			global: { scout: { model: "provider/reasoner" } },
		});
		const { ctx, select } = makeContext({
			mode: "tui",
			models: harness.availableModels,
			customResults: ["__default__"],
			selectResults: ["Global default"],
		});

		await harness.handler("scout", ctx);

		expect(select).toHaveBeenCalledOnce();
		expect(harness.resetGlobal).toHaveBeenCalledWith("scout");
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
		expect(harness.saveGlobal).not.toHaveBeenCalled();
	});
});
