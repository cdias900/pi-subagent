import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";
import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { AgentConfig, AgentDiscoveryResult } from "./agents.js";
import { discoverAgents } from "./agents.js";
import registerExtension, { buildEffectiveConfig } from "./index.js";
import {
	loadGlobalConfig,
	type SubagentModelConfig,
} from "./model-config.js";
import { SESSION_OVERRIDES_CUSTOM_TYPE } from "./model-session.js";

vi.mock("./agents.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./agents.js")>();
	return { ...actual, discoverAgents: vi.fn(actual.discoverAgents) };
});

vi.mock("./model-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./model-config.js")>();
	return { ...actual, loadGlobalConfig: vi.fn(actual.loadGlobalConfig) };
});

function agent(model?: string): AgentConfig {
	return {
		name: "scout",
		description: "Find relevant code",
		model,
		systemPrompt: "Scout the repository.",
		source: "bundled",
		filePath: "/agents/scout.md",
	};
}

describe("buildEffectiveConfig", () => {
	it("uses frontmatter when no override exists", () => {
		expect(buildEffectiveConfig(agent("anthropic/frontmatter:high"), {})).toEqual({
			model: "anthropic/frontmatter",
			thinkingLevel: "high",
			modelSource: "frontmatter",
			thinkingLevelSource: "frontmatter",
			source: "frontmatter",
		});
	});

	it("lets global config override frontmatter", () => {
		expect(
			buildEffectiveConfig(agent("anthropic/frontmatter:high"), {
				global: { model: "openai/global:medium" },
			}),
		).toEqual({
			model: "openai/global",
			thinkingLevel: "medium",
			modelSource: "global",
			thinkingLevelSource: "global",
			source: "global",
		});
	});

	it("lets session config override global config", () => {
		expect(
			buildEffectiveConfig(agent("anthropic/frontmatter"), {
				global: { model: "openai/global", thinkingLevel: "medium" },
				session: { model: "google/session", thinkingLevel: "high" },
			}),
		).toEqual({
			model: "google/session",
			thinkingLevel: "high",
			modelSource: "session",
			thinkingLevelSource: "session",
			source: "session",
		});
	});

	it("inherits the parent model and reasoning for a model-less agent", () => {
		expect(
			buildEffectiveConfig(agent(), {
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

	it("reports the parent source when neither agent nor parent has a model", () => {
		expect(buildEffectiveConfig(agent(), {})).toEqual({
			model: undefined,
			thinkingLevel: undefined,
			modelSource: "parent",
			thinkingLevelSource: undefined,
			source: "parent",
		});
	});

	it("keeps a lower model and source when session only changes thinking", () => {
		expect(
			buildEffectiveConfig(agent("anthropic/frontmatter"), {
				global: { model: "openai/global", thinkingLevel: "low" },
				session: { thinkingLevel: "max" },
			}),
		).toEqual({
			model: "openai/global",
			thinkingLevel: "max",
			modelSource: "global",
			thinkingLevelSource: "session",
			source: "global",
		});
	});
});

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
}

interface CapturedTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
}

type EventHandler = (...args: unknown[]) => unknown;

const tools = new Map<string, CapturedTool>();
const eventHandlers = new Map<string, EventHandler>();
const getThinkingLevel = vi.fn(() => "medium" as const);

function captureExtensionRegistration(): void {
	const pi = {
		getThinkingLevel,
		on(event: string, handler: EventHandler) {
			eventHandlers.set(event, handler);
		},
		registerCommand() {},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;

	registerExtension(pi, {
		settings: { allowInvocationModelOverrides: true },
	});
}

function discoveryFor(agents: AgentConfig[]): AgentDiscoveryResult {
	return {
		agents,
		projectAgentsDir: null,
		diagnostics: ["agent discovery warning"],
	};
}

function context(): ExtensionContext {
	return {
		cwd: "/workspace",
		model: { provider: "openai", id: "parent" },
	} as unknown as ExtensionContext;
}

function startSession(branch: readonly SessionEntry[], hasUI = false): void {
	const handler = eventHandlers.get("session_start");
	expect(handler).toBeDefined();
	handler!(
		{},
		{
			hasUI,
			sessionManager: { getBranch: () => branch },
			...(hasUI ? { ui: { setWidget: vi.fn() } } : {}),
		} as unknown as ExtensionContext,
	);
}

function sessionSnapshot(overrides: SubagentModelConfig): SessionEntry {
	return {
		type: "custom",
		customType: SESSION_OVERRIDES_CUSTOM_TYPE,
		data: { version: 1, overrides },
	} as SessionEntry;
}

function requiredTool(name: string): CapturedTool {
	const tool = tools.get(name);
	expect(tool, `${name} must be registered`).toBeDefined();
	return tool!;
}

beforeAll(() => {
	captureExtensionRegistration();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(discoverAgents).mockReturnValue(discoveryFor([agent("anthropic/frontmatter:low")]));
	vi.mocked(loadGlobalConfig).mockReturnValue({
		config: {},
		path: "/config/subagent-models.json",
	});
	startSession([]);
});

describe("discovery effective model metadata", () => {
	it("restores session overrides for a headless session", async () => {
		vi.mocked(loadGlobalConfig).mockReturnValue({
			config: { scout: { model: "openai/global", thinkingLevel: "low" } },
			path: "/config/subagent-models.json",
		});
		startSession([
			sessionSnapshot({
				scout: { model: "google/session", thinkingLevel: "high" },
			}),
		]);

		const result = await requiredTool("list_subagents").execute(
			"list-call",
			{},
			undefined,
			undefined,
			context(),
		);
		const details = result.details as {
			agents: Array<{ effective: Record<string, unknown> }>;
		};

		expect(details.agents[0].effective).toEqual({
			model: "google/session",
			thinkingLevel: "high",
			source: "session",
		});
	});

	it("loads valid global config once and never emits stale override-only names", async () => {
		vi.mocked(loadGlobalConfig).mockReturnValue({
			config: {
				scout: { model: "openai/global", thinkingLevel: "high" },
				stale: { model: "google/stale" },
			},
			path: "/config/subagent-models.json",
		});

		const result = await requiredTool("list_subagents").execute(
			"list-call",
			{},
			undefined,
			undefined,
			context(),
		);
		const details = result.details as {
			count: number;
			agents: Array<{ name: string; effective: Record<string, unknown> }>;
		};

		expect(loadGlobalConfig).toHaveBeenCalledTimes(1);
		expect(getThinkingLevel).toHaveBeenCalledTimes(1);
		expect(details.count).toBe(1);
		expect(details.agents.map(({ name }) => name)).toEqual(["scout"]);
		expect(details.agents[0].effective).toEqual({
			model: "openai/global",
			thinkingLevel: "high",
			source: "global",
		});
	});

	it("keeps list and describe available when global config is malformed", async () => {
		const configError = "/config/subagent-models.json: malformed JSON";
		vi.mocked(loadGlobalConfig).mockReturnValue({
			config: {},
			error: configError,
			path: "/config/subagent-models.json",
		});

		const listPromise = requiredTool("list_subagents").execute(
			"list-call",
			{},
			undefined,
			undefined,
			context(),
		);
		await expect(listPromise).resolves.toBeDefined();
		const listResult = await listPromise;
		const listDetails = listResult.details as {
			diagnostics: string[];
			agents: Array<{ effective: Record<string, unknown> }>;
		};
		expect(loadGlobalConfig).toHaveBeenCalledTimes(1);
		expect(getThinkingLevel).toHaveBeenCalledTimes(1);
		expect(listDetails.diagnostics).toEqual([
			"agent discovery warning",
			configError,
		]);
		expect(listDetails.agents[0].effective).toEqual({
			model: "anthropic/frontmatter",
			thinkingLevel: "low",
			source: "frontmatter",
		});

		vi.mocked(loadGlobalConfig).mockClear();
		getThinkingLevel.mockClear();
		const describePromise = requiredTool("describe_agent").execute(
			"describe-call",
			{ agent: "scout" },
			undefined,
			undefined,
			context(),
		);
		await expect(describePromise).resolves.toBeDefined();
		const describeResult = await describePromise;
		const describeDetails = describeResult.details as {
			name: string;
			model?: string;
			configError?: string;
			effective: Record<string, unknown>;
		};
		expect(loadGlobalConfig).toHaveBeenCalledTimes(1);
		expect(getThinkingLevel).toHaveBeenCalledTimes(1);
		expect(describeDetails).toMatchObject({
			name: "scout",
			model: "anthropic/frontmatter:low",
			configError,
		});
		expect(describeDetails.effective).toEqual({
			model: "anthropic/frontmatter",
			thinkingLevel: "low",
			source: "frontmatter",
		});
	});

	it("fail-closes subagent dispatch with a self-serving error when the global config is corrupt", async () => {
		const configError = "/config/subagent-models.json: Unexpected token } in JSON";
		vi.mocked(loadGlobalConfig).mockReturnValue({
			config: {},
			error: configError,
			path: "/config/subagent-models.json",
		});

		const dispatch = requiredTool("subagent").execute(
			"subagent-call",
			{ agent: "scout", task: "do something" },
			undefined,
			undefined,
			context(),
		);

		let thrown = "";
		try {
			await dispatch;
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		}
		expect(thrown).not.toBe("");
		expect(thrown).toContain("/config/subagent-models.json");
		expect(thrown).toContain("--force");
		expect(thrown).toContain("/agent-model global reset --force");
		// The underlying parse problem must still be visible.
		expect(thrown).toContain("Unexpected token } in JSON");
	});
});
