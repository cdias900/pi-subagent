import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents.js";
import type {
	AgentModelFileChange,
	AgentModelFileResult,
} from "./agent-model-file.js";
import {
	buildModelItems,
	filterModelItems,
	formatTokenLimit,
	parseAgentModelArgs,
	registerAgentModelCommand,
	type AgentModelCommandDeps,
} from "./agent-model-command.js";
import type {
	AgentModelOverride,
	ForceResetResult,
	SubagentModelConfig,
} from "./model-config.js";
import { normalizeModelString } from "./model-normalize.js";
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
		source: "user",
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
	const persistAgentModel = vi.fn(
		(agent: AgentConfig, change: AgentModelFileChange): AgentModelFileResult => {
			const model = change.model === undefined
				? undefined
				: change.thinkingLevel === undefined
					? normalizeModelString(change.model).base
					: `${normalizeModelString(change.model).base}:${change.thinkingLevel}`;
			return {
				config: { ...agent, model },
				path: agent.filePath,
				changed: model !== agent.model,
			};
		},
	);
	const forceResetGlobal = vi.fn((): ForceResetResult => ({
		backupPath: "/config/subagent-models.json.corrupt-2025-01-01T00-00-00-000Z",
		recoveredPath: "/config/subagent-models.json",
	}));

	const deps: AgentModelCommandDeps = {
		discover: vi.fn(() => agents),
		getSessionOverrides: vi.fn(() => session),
		setSessionOverride,
		loadGlobal: vi.fn(() => ({
			config: global,
			path: "/config/subagent-models.json",
		})),
		persistAgentModel,
		forceResetGlobal,
		makePort: vi.fn(() => port),
		parentFor: vi.fn((): AgentModelOverride => ({
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
		persistAgentModel,
		forceResetGlobal,
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
	expect(harness.persistAgentModel).not.toHaveBeenCalled();
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

	it("parses the full-global force-reset form", () => {
		expect(parseAgentModelArgs("global reset --force")).toEqual({
			kind: "forceReset",
		});
	});

	it.each([
		["session reset --force", "only valid for the global scope"],
		["global reset", "Missing arguments for the global form"],
		["global reset --force extra", "Use \"/agent-model global reset --force\""],
		["global reset --recover", "Use \"/agent-model global reset --force\""],
	])("rejects malformed force-reset form %j with usage", (input, expected) => {
		const parsed = parseAgentModelArgs(input);
		expect(parsed.kind).toBe("error");
		if (parsed.kind === "error") {
			expect(parsed.message).toContain(expected);
			expect(parsed.message).toContain("Usage:");
		}
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
		expect(harness.persistAgentModel).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/scout[\s\S]*provider\/reasoner[\s\S]*max[\s\S]*session/i),
			"info",
		);
	});

	it("persists a global selection in the user agent frontmatter", async () => {
		const harness = makeHarness();
		const { ctx, notify } = makeContext({ mode: "rpc" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expect(harness.persistAgentModel).toHaveBeenCalledOnce();
		expect(harness.persistAgentModel).toHaveBeenCalledWith(
			harness.agents[0],
			{
				model: "provider/reasoner",
				thinkingLevel: "high",
			},
		);
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/scout[\s\S]*provider\/reasoner[\s\S]*high[\s\S]*frontmatter[\s\S]*global[\s\S]*\/agents\/scout\.md/i),
			"info",
		);
	});

	it("rejects a durable change for a bundled agent", async () => {
		const bundled = { ...fakeAgent("scout"), source: "bundled" as const };
		const harness = makeHarness({ agents: [bundled] });
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/bundled-source[\s\S]*user-owned copy/i),
			"error",
		);
	});

	it("rejects a frontmatter change while a legacy JSON entry would mask it", async () => {
		const harness = makeHarness({
			global: { scout: { model: "provider/plain", thinkingLevel: "off" } },
		});
		const { ctx, notify } = makeContext({ mode: "rpc" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/legacy override[\s\S]*subagent-models\.json[\s\S]*mask[\s\S]*remove/i),
			"error",
		);
	});

	it("allows a frontmatter change when only another agent has a legacy entry", async () => {
		const harness = makeHarness({
			global: { executor: { model: "provider/plain" } },
		});
		const { ctx } = makeContext({ mode: "rpc" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expect(harness.persistAgentModel).toHaveBeenCalledOnce();
	});

	it.each([
		["session", "setSessionOverride"],
		["global", "persistAgentModel"],
	] as const)("resets only the %s scope", async (scope, expectedWrite) => {
		const scout = fakeAgent("scout", "provider/reasoner:high");
		const harness = makeHarness({
			agents: [scout, fakeAgent("executor")],
			session: { scout: { model: "provider/reasoner" } },
		});
		const { ctx } = makeContext({ mode: "tui" });

		await harness.handler(`${scope} scout reset`, ctx);

		if (expectedWrite === "setSessionOverride") {
			expect(harness.setSessionOverride).toHaveBeenCalledWith(
				"scout",
				undefined,
			);
			expect(harness.persistAgentModel).not.toHaveBeenCalled();
		} else {
			expect(harness.persistAgentModel).toHaveBeenCalledWith(scout, {
				model: undefined,
			});
			expect(harness.setSessionOverride).not.toHaveBeenCalled();
		}
	});

	it("force-resets the entire global config and reports the backup and recovered paths", async () => {
		const harness = makeHarness();
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("global reset --force", ctx);

		expect(harness.forceResetGlobal).toHaveBeenCalledOnce();
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
		expect(harness.persistAgentModel).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/Legacy global subagent model configuration reset[\s\S]*Recovered:[\s\S]*\/config\/subagent-models\.json[\s\S]*Backup of corrupt file:[\s\S]*\.corrupt-/),
			"info",
		);
	});

	it("force-reset works without a live UI-capable mode (recovery command)", async () => {
		const harness = makeHarness();
		const { ctx, notify } = makeContext({ mode: "json", hasUI: true });

		await harness.handler("global reset --force", ctx);

		expect(harness.forceResetGlobal).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Legacy global subagent model configuration reset"),
			"info",
		);
	});

	it("force-reset surfaces a no-backup message when no file existed", async () => {
		const harness = makeHarness();
		harness.forceResetGlobal.mockReturnValue({
			backupPath: undefined,
			recoveredPath: "/config/subagent-models.json",
		});
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("global reset --force", ctx);

		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("No existing file was found"),
			"info",
		);
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

	it("succeeds a session-scope change and warns when the global config is corrupt", async () => {
		const harness = makeHarness();
		harness.deps.loadGlobal = vi.fn(() => ({
			config: {},
			error: "/config/subagent-models.json: malformed JSON",
			path: "/config/subagent-models.json",
		}));
		const { ctx, notify } = makeContext({ mode: "tui" });

		await harness.handler("session scout provider/reasoner high", ctx);

		expect(harness.setSessionOverride).toHaveBeenCalledOnce();
		expect(harness.setSessionOverride).toHaveBeenCalledWith("scout", {
			model: "provider/reasoner",
			thinkingLevel: "high",
		});
		expect(harness.persistAgentModel).not.toHaveBeenCalled();
		// The success notification is still emitted.
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/scout[\s\S]*provider\/reasoner[\s\S]*high[\s\S]*session/i),
			"info",
		);
		// The global corruption is surfaced as a non-fatal warning that mentions recovery.
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("malformed JSON"),
			"warning",
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("/agent-model global reset --force"),
			"warning",
		);
	});

	it("still fails closed for a global-scope change when the global config is corrupt", async () => {
		const harness = makeHarness();
		harness.deps.loadGlobal = vi.fn(() => ({
			config: {},
			error: "/config/subagent-models.json: malformed JSON",
			path: "/config/subagent-models.json",
		}));
		const { ctx, notify } = makeContext({ mode: "rpc" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expectNoWrites(harness);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("malformed JSON"),
			"error",
		);
	});

	it("catches frontmatter persistence errors without writing the session scope", async () => {
		const harness = makeHarness();
		harness.persistAgentModel.mockImplementation(() => {
			throw new Error("disk is read-only");
		});
		const { ctx, notify } = makeContext({ mode: "rpc" });

		await harness.handler("global scout provider/reasoner high", ctx);

		expect(harness.getGlobal()).toEqual({});
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
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
		expect(harness.persistAgentModel).not.toHaveBeenCalled();
		expect(harness.isAvailable).toHaveBeenCalledOnce();
		expect(harness.isAvailable).toHaveBeenCalledWith(model);
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			'Agent "scout" updated: model provider/reasoner; reasoning high; source session; scope Current Pi session (session).',
			"info",
		);
	});

	it("persists model-default reasoning without a thinking suffix in frontmatter", async () => {
		const model = fakeModel("provider", "reasoner");
		const harness = makeHarness({ models: [model], availableModels: [model] });
		const { ctx } = makeContext({
			mode: "tui",
			models: [model],
			customResults: ["provider/reasoner"],
			selectResults: ["Use agent default", "User agent file (global)"],
		});

		await harness.handler("scout", ctx);

		expect(harness.persistAgentModel).toHaveBeenCalledOnce();
		expect(harness.persistAgentModel).toHaveBeenCalledWith(
			harness.agents[0],
			{ model: "provider/reasoner" },
		);
		const savedChange = harness.persistAgentModel.mock.calls[0]?.[1];
		expect(savedChange).toStrictEqual({ model: "provider/reasoner" });
		expect(savedChange).not.toHaveProperty("thinkingLevel");
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
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

	it("skips reasoning and removes the frontmatter model for the global default", async () => {
		const scout = fakeAgent("scout", "provider/reasoner:high");
		const harness = makeHarness({
			agents: [scout, fakeAgent("executor")],
			session: { scout: { model: "provider/reasoner" } },
		});
		const { ctx, select } = makeContext({
			mode: "tui",
			models: harness.availableModels,
			customResults: ["__default__"],
			selectResults: ["User agent file (global)"],
		});

		await harness.handler("scout", ctx);

		expect(select).toHaveBeenCalledOnce();
		expect(harness.persistAgentModel).toHaveBeenCalledWith(scout, {
			model: undefined,
		});
		expect(harness.setSessionOverride).not.toHaveBeenCalled();
	});
});

function limitModel(overrides: {
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
}): Model<Api> {
	return overrides as unknown as Model<Api>;
}

describe("formatTokenLimit", () => {
	it.each([
		[1_000_000, "1M"],
		[1_500_000, "1.5M"],
		[3_500_000, "3.5M"],
		[1_234_567, "1.2M"],
		[1_050_000, "1M"],
		[128_000, "128K"],
		[200_000, "200K"],
		[8_500, "8.5K"],
		[8192, "8K"],
		[900, "900"],
	])("formats %d as %s", (limit, expected) => {
		expect(formatTokenLimit(limit)).toBe(expected);
	});

	it.each([
		[0],
		[-1],
		[Number.NaN],
		[Number.POSITIVE_INFINITY],
		[Number.NEGATIVE_INFINITY],
	])("returns an empty string for %d", (limit) => {
		expect(formatTokenLimit(limit)).toBe("");
	});
});

describe("buildModelItems", () => {
	it("pins the agent-default entry first", () => {
		const items = buildModelItems([fakeModel("provider", "reasoner")]);

		expect(items[0]).toEqual({
			value: "__default__",
			label: "Use agent default",
			description: "Clear the selected scope's model setting",
		});
		expect(items[1]?.value).toBe("provider/reasoner");
	});

	it("appends context and output hints to the description", () => {
		const items = buildModelItems([
			limitModel({
				provider: "anthropic",
				id: "claude-opus-4-6",
				name: "Claude Opus 4.6",
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			}),
		]);

		expect(items[1]?.description).toBe("Claude Opus 4.6 · 1M ctx · 128K out");
	});

	it("omits only the unavailable segment", () => {
		const items = buildModelItems([
			limitModel({
				provider: "prov",
				id: "m",
				name: "M",
				contextWindow: 32_000,
			}),
		]);

		expect(items[1]?.description).toBe("M · 32K ctx");
	});
});

describe("filterModelItems", () => {
	const opus = limitModel({
		provider: "anthropic-1m",
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
	const zebra = limitModel({ provider: "prov", id: "m-1", name: "Zebra" });
	const items = buildModelItems([opus, zebra]);

	it("returns every item for an empty query", () => {
		expect(filterModelItems(items, "")).toEqual(items);
	});

	it("returns every item for a whitespace-only query", () => {
		expect(filterModelItems(items, "   ")).toEqual(items);
	});

	it("matches inside provider/id where setFilter's startsWith failed", () => {
		const filtered = filterModelItems(items, "opus");

		expect(filtered.map((item) => item.value)).toEqual([
			"__default__",
			"anthropic-1m/claude-opus-4-6",
		]);
	});

	it("matches multi-token queries", () => {
		const filtered = filterModelItems(items, "anthropic opus");

		expect(filtered.map((item) => item.value)).toEqual([
			"__default__",
			"anthropic-1m/claude-opus-4-6",
		]);
	});

	// The dev SDK's fuzzyFilter splits on whitespace only, so "1m/opus" stays a
	// single token and matches as an in-order subsequence of
	// "anthropic-1m/claude-opus-4-6"; the host SDK splits on "/" too and matches
	// both tokens. This case passes under BOTH tokenizers.
	it("matches slash-containing queries", () => {
		const filtered = filterModelItems(items, "1m/opus");

		expect(filtered.map((item) => item.value)).toEqual([
			"__default__",
			"anthropic-1m/claude-opus-4-6",
		]);
	});

	it("searches the description text", () => {
		const filtered = filterModelItems(items, "zebra");

		expect(filtered.map((item) => item.value)).toEqual([
			"__default__",
			"prov/m-1",
		]);
	});

	it("keeps only the pinned entry when nothing matches", () => {
		expect(
			filterModelItems(items, "qqqq").map((item) => item.value),
		).toEqual(["__default__"]);
	});

	it("keeps the pinned entry first while filtering", () => {
		expect(filterModelItems(items, "claude")[0]?.value).toBe("__default__");
	});
});
