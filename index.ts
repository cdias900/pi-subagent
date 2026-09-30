/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Runs each subagent in an in-process Pi SDK session with its own context.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses typed SDK session events for results and lifecycle control.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentDiscoveryResult, type AgentScope, discoverAgents } from "./agents.js";
import { hasTerminalFailure, isSuccessfulResult } from "./result-status.js";
import { registerAgentModelCommand } from "./agent-model-command.js";
import { persistAgentModelFile } from "./agent-model-file.js";
import { createSdkChild, resolveSdkProjectTrust, type SdkChild } from "./sdk-runner.js";
import { loadScopedMcpServers } from "./sdk-mcp.js";
import { AgentsPanel, type PanelAgent, type TranscriptEntry } from "./agents-panel.js";
import { registerCoordinationTools } from "./coordination.js";
import {
	buildCompactAgentInfo,
	buildFullAgentContract,
	formatJson,
} from "./parameters.js";
import {
	type AgentInvocation,
	resolveInvocation,
	displayInputSummary,
} from "./invocation.js";
import {
	assertInvocationModelOverridesAllowed,
	loadSubagentSettings,
	type SubagentSettings,
} from "./invocation-policy.js";
import {
	formatGlobalConfigDispatchError,
	forceResetGlobalConfig,
	loadGlobalConfig,
	type AgentModelOverride,
	type SubagentModelConfig,
} from "./model-config.js";
import {
	isThinkingLevel,
	normalizeModelString,
	splitProviderModel,
	type SubagentThinkingLevel,
} from "./model-normalize.js";
import {
	getSupportedThinkingLevelsCompat,
	type ModelCatalogPort,
	type ModelSource,
	type ResolvedModelConfig,
	resolveModelLayers,
	validateResolvedModel,
} from "./model-resolution.js";
import {
	appendSessionOverridesSnapshot,
	computeUpdatedOverrides,
	restoreSessionOverrides,
} from "./model-session.js";
import {
	deleteTeam,
	ensureTeamDir,
	getTeamDir,
	getTeamsDir,
	listOutputs,
	listTeams,
	loadSharedContext,
	saveOutput,
	teamExists,
} from "./team.js";

/**
 * Build a map of extension name -> file path by scanning the agent directory.
 * Checks: global extensions dir, and extensions subdirectories within installed git packages.
 * Extension names are derived from directory names or filenames (without .ts).
 */
function buildExtensionMap(agentDir: string): Map<string, string> {
	const extMap = new Map<string, string>();

	// 1. Global extensions: ~/.pi/agent*/extensions/*.ts and ~/.pi/agent*/extensions/*/index.ts
	const globalExtDir = path.join(agentDir, "extensions");
	if (fs.existsSync(globalExtDir)) {
		for (const entry of fs.readdirSync(globalExtDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".ts")) {
				const name = entry.name.replace(/\.ts$/, "");
				extMap.set(name, path.join(globalExtDir, entry.name));
			} else if (entry.isDirectory() || entry.isSymbolicLink()) {
				const idx = path.join(globalExtDir, entry.name, "index.ts");
				if (fs.existsSync(idx)) {
					extMap.set(entry.name, idx);
				}
			}
		}
	}

	// 2. Installed git packages — scan extensions/ subdirectories AND package roots
	const gitDir = path.join(agentDir, "git", "github.com");
	if (fs.existsSync(gitDir)) {
		for (const user of fs.readdirSync(gitDir, { withFileTypes: true })) {
			if (!user.isDirectory()) continue;
			const userDir = path.join(gitDir, user.name);
			for (const repo of fs.readdirSync(userDir, { withFileTypes: true })) {
				if (!repo.isDirectory()) continue;
				const pkgExtDir = path.join(userDir, repo.name, "extensions");
				if (fs.existsSync(pkgExtDir)) {
					for (const ext of fs.readdirSync(pkgExtDir, { withFileTypes: true })) {
						if (ext.isDirectory()) {
							const extIdx = path.join(pkgExtDir, ext.name, "index.ts");
							if (fs.existsSync(extIdx)) {
								extMap.set(ext.name, extIdx);
							}
						}
					}
				}
				// Also register package-root extensions: a repo whose entry point is
				// index.ts at the repo root, keyed by repo name, so subagents can load
				// them via extensions: ["<repo-name>"]. Existing global / extensions-subdir
				// entries take precedence.
				if (!extMap.has(repo.name)) {
					const rootExtIdx = path.join(userDir, repo.name, "index.ts");
					if (fs.existsSync(rootExtIdx)) {
						extMap.set(repo.name, rootExtIdx);
					}
				}
			}
		}
	}

	return extMap;
}

/**
 * Resolve requested extension names to file paths.
 * Returns only the paths for extensions that exist and were requested.
 */
function resolveExtensionPaths(agentDir: string, requested: string[]): string[] {
	const extMap = buildExtensionMap(agentDir);
	const resolved: string[] = [];
	for (const name of requested) {
		const extPath = extMap.get(name);
		if (!extPath) throw new Error(`Requested child extension "${name}" is not installed`);
		resolved.push(extPath);
	}
	return resolved;
}

function readPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The single concurrency limit for this extension, covering both the number
 * of agents in one parallel `subagent` call and how many background agents
 * run at once. Each agent has its own SDK session and LLM calls,
 * so raising this costs memory and pushes harder against
 * provider rate limits. Override with PI_SUBAGENT_MAX_AGENTS.
 */
const MAX_PARALLEL_AGENTS = readPositiveIntEnv("PI_SUBAGENT_MAX_AGENTS", 50);
const COLLAPSED_ITEM_COUNT = 10;
const MAX_COMPLETED_RETENTION = 20;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/** Known context window sizes (tokens) for common models. */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
	"claude-sonnet-4-20250514": 200000,
	"claude-haiku-4-5-20250414": 200000,
	"claude-opus-4-20250514": 200000,
	"claude-opus-4-6": 1000000,
	"gpt-5.4": 200000,
	"gpt-5.4-mini": 200000,
	"gpt-4.1": 1047576,
	"gpt-4.1-mini": 1047576,
	"gpt-4.1-nano": 1047576,
	"o3": 200000,
	"o4-mini": 200000,
	"gemini-2.5-pro": 1048576,
	"gemini-2.5-flash": 1048576,
};

function getContextWindow(model: string): number | null {
	// Try exact match first
	if (KNOWN_CONTEXT_WINDOWS[model]) return KNOWN_CONTEXT_WINDOWS[model];
	// Try prefix match (e.g. "claude-sonnet-4" matches "claude-sonnet-4-20250514")
	for (const [key, value] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
		if (key.startsWith(model) || model.startsWith(key)) return value;
	}
	return null;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	opts?: {
		provider?: string;
		elapsedMs?: number;
		contextWindow?: number;
		thinkingLevel?: SubagentThinkingLevel;
		source?: ModelSource;
	},
): string {
	const sep = " │ ";
	const hasSingleAgentData = !!model;

	if (hasSingleAgentData) {
		const parsed = normalizeModelString(model);

		// Two-line format for single agent results
		// Line 1: tokens │ cost │ context %
		const line1Parts: string[] = [];
		const totalTokens = (usage.input || 0) + (usage.output || 0);
		if (totalTokens > 0) line1Parts.push(`${formatTokens(totalTokens)} tokens`);
		if (usage.cost) line1Parts.push(`$${usage.cost.toFixed(3)}`);
		if (usage.contextTokens && usage.contextTokens > 0) {
			const ctxWindow = opts?.contextWindow ?? getContextWindow(parsed.modelId);
			if (ctxWindow) {
				const pct = ((usage.contextTokens / ctxWindow) * 100).toFixed(1);
				line1Parts.push(`${pct}% (${formatTokens(usage.contextTokens)}/${formatTokens(ctxWindow)})`);
			} else {
				line1Parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
			}
		}

		// Line 2: turns │ provider ● model ● reasoning │ elapsed
		const line2Parts: string[] = [];
		if (usage.turns) line2Parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
		const provider = opts?.provider || (parsed.provider ?? "—");
		const reasoning = opts?.thinkingLevel ?? parsed.thinkingLevel ?? "off";
		const modelLine = `${provider} ● ${parsed.modelId} ● ${reasoning}`;
		line2Parts.push(opts?.source ? `${modelLine} ● ${opts.source}` : modelLine);
		if (opts?.elapsedMs && opts.elapsedMs > 0) {
			line2Parts.push(formatDuration(opts.elapsedMs));
		}

		return [line1Parts.join(sep), line2Parts.join(sep)].filter(Boolean).join("\n");
	}

	// Single-line format for aggregate totals (no model/provider data)
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turns`);
	const totalTokens = (usage.input || 0) + (usage.output || 0);
	if (totalTokens > 0) parts.push(`${formatTokens(totalTokens)} tokens`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	if (opts?.elapsedMs && opts.elapsedMs > 0) {
		parts.push(formatDuration(opts.elapsedMs));
	}
	return parts.join(sep);
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	backend?: "sdk";
	agent: string;
	agentSource: "user" | "project" | "bundled" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	provider?: string;
	contextWindow?: number;
	resolvedModel?: string;
	resolvedThinkingLevel?: SubagentThinkingLevel;
	configSource?: ModelSource;
	stopReason?: string;
	errorMessage?: string;
	completionSignal?: "done" | "error";
	step?: number;
	savedAs?: string;
	startTime: number;
	promptKind?: "task" | "input";
	input?: unknown;
}

export function buildResolvedModelMetadata(
	resolved: ResolvedModelConfig,
): {
	resolvedModel?: string;
	resolvedThinkingLevel?: SubagentThinkingLevel;
	configSource: ModelSource;
} {
	return {
		...(resolved.model !== undefined ? { resolvedModel: resolved.model } : {}),
		...(resolved.thinkingLevel !== undefined
			? { resolvedThinkingLevel: resolved.thinkingLevel }
			: {}),
		configSource: resolved.source,
	};
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	team?: string;
	results: SingleResult[];
}

interface BackgroundAgent {
	id: string;
	agent: string;
	task: string;
	prompt: string;
	promptKind: "task" | "input";
	input?: unknown;
	sdk?: SdkChild;
	setupController?: AbortController;
	sdkReady?: Promise<SdkChild>;
	sdkCleanup?: Promise<void>;
	sdkCleanupStarted?: boolean;
	sdkRunId?: number;
	interrupting?: boolean;
	resolvedModel?: ResolvedModelConfig;
	currentTool?: string;
	lastEventAt?: number;
	result: SingleResult;
	status: "queued" | "running" | "waiting" | "done" | "error" | "aborted";
	startTime: number;
	endTime?: number;
	cwd: string;
	agentConfig: AgentConfig;
	teamName?: string;
	saveAs?: string;
	extensions?: string[];
	mcps?: string[];
	groupId?: string;
}

interface ForegroundAgentHandle {
	id: string;
	agentName: string;
	task: string;
	controller: AbortController;
	startTime: number;
	lastEventAt: number;
	currentTool?: string;
	turns: number;
	result?: SingleResult;
}
const foregroundAgents = new Map<string, ForegroundAgentHandle>();
let foregroundAgentSeq = 0;

function listForegroundAgents(): ForegroundAgentHandle[] {
	return [...foregroundAgents.values()];
}

function killForegroundAgent(id: string): boolean {
	const h = foregroundAgents.get(id);
	if (!h) return false;
	h.controller.abort();
	return true;
}

const backgroundAgents = new Map<string, BackgroundAgent>();
const bgAutoCounter = new Map<string, number>();
let sessionModelOverrides: SubagentModelConfig = {};
let piRef: ExtensionAPI | null = null;

function parentModelForContext(ctx: ExtensionContext): AgentModelOverride {
	const parentThinkingLevel = piRef?.getThinkingLevel();
	return {
		model: ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: undefined,
		thinkingLevel:
			parentThinkingLevel !== undefined && isThinkingLevel(parentThinkingLevel)
				? parentThinkingLevel
				: undefined,
	};
}

export function buildEffectiveConfig(
	agent: Pick<AgentConfig, "model">,
	opts: {
		session?: AgentModelOverride;
		global?: AgentModelOverride;
		parent?: AgentModelOverride;
	},
): ResolvedModelConfig {
	return resolveModelLayers({
		parent: opts.parent,
		layers: [
			{ model: agent.model, source: "frontmatter" },
			opts.global === undefined
				? undefined
				: { ...opts.global, source: "global" },
			opts.session === undefined
				? undefined
				: { ...opts.session, source: "session" },
		],
	});
}

function buildModelResolution(
	agentName: string,
	invocation: AgentModelOverride,
	globalOverride: AgentModelOverride | undefined,
	parent: AgentModelOverride,
): {
	invocation: AgentModelOverride;
	session?: AgentModelOverride;
	global?: AgentModelOverride;
	parent: AgentModelOverride;
} {
	return {
		invocation,
		session: sessionModelOverrides[agentName],
		global: globalOverride,
		parent,
	};
}

type PublicModelRegistry = Pick<
	ExtensionContext["modelRegistry"],
	"find" | "getAll" | "getAvailable"
>;

export function makeModelCatalogPort(
	registry: PublicModelRegistry,
): ModelCatalogPort {
	return {
		findExact(provider, id) {
			if (provider === undefined) return undefined;
			return registry.find(provider, id);
		},
		resolvePattern(pattern) {
			const { provider, modelId } = splitProviderModel(pattern);
			if (provider !== undefined) {
				const exact = registry.find(provider, modelId);
				if (exact !== undefined) return exact;
			}

			const normalizedPattern = pattern.toLowerCase();
			const models = registry.getAll();
			const exactFullId = models.find(
				(model) =>
					`${model.provider}/${model.id}`.toLowerCase() === normalizedPattern,
			);
			if (exactFullId !== undefined) return exactFullId;

			const normalizedModelId = modelId.toLowerCase();
			// Keep provider-qualified aliases scoped without changing registry order.
			const fallbackModels =
				provider === undefined
					? models
					: models.filter(
							(model) =>
								model.provider.toLowerCase() === provider.toLowerCase(),
						);
			const exactBareId = fallbackModels.find(
				(model) => model.id.toLowerCase() === normalizedModelId,
			);
			if (exactBareId !== undefined) return exactBareId;

			return fallbackModels.find(
				(model) =>
					model.id.toLowerCase().includes(normalizedModelId) ||
					model.name?.toLowerCase().includes(normalizedModelId),
			);
		},
		isAvailable(model: Model<Api>) {
			return registry
				.getAvailable()
				.some(
					(available) =>
						available.provider === model.provider && available.id === model.id,
				);
		},
		supportedThinkingLevels(model) {
			return getSupportedThinkingLevelsCompat(model);
		},
	};
}

function makeCatalogPort(
	ctx: Pick<ExtensionContext, "modelRegistry">,
): ModelCatalogPort {
	return makeModelCatalogPort(ctx.modelRegistry);
}

export function preflightValidateInvocations(
	invocations: readonly AgentInvocation[],
	port: ModelCatalogPort,
	defaultCwd = process.cwd(),
): void {
	for (const invocation of invocations) {
		childResources(invocation.agent, invocation.extensions, invocation.mcps, invocation.cwd ?? defaultCwd);
		const result = validateResolvedModel(invocation.resolvedModel, port, {
			agentName: invocation.agentName,
		});
		if (!result.ok) throw new Error(result.error);
	}
}

// ── V2: Background Groups ──────────────────────────────────────────
interface ChainStepDef {
	agent: string;
	task?: string;
	input?: unknown;
	cwd?: string;
	saveAs?: string;
	mcps?: string[];
	extensions?: string[];
	readonly resolvedModel: ResolvedModelConfig;
}

interface BackgroundGroup {
	groupId: string;
	mode: "parallel" | "chain";
	memberIds: string[];
	status: "running" | "done" | "error" | "aborted";
	startTime: number;
	endTime?: number;
	chainSteps?: ChainStepDef[];
	currentStepIndex?: number;
	previousOutput?: string;
	notifyPerTask: boolean;
	teamName?: string;
	saveAs?: string;
	agents?: AgentConfig[];
	agentScope?: AgentScope;
	defaultCwd?: string;
}

const backgroundGroups = new Map<string, BackgroundGroup>();
let bgWidgetInterval: ReturnType<typeof setInterval> | null = null;

// UI context captured on session_start — used for widget updates
let uiSetWidget: ((key: string, content: string[] | undefined) => void) | null = null;


/**
 * Update the widget showing active background agents.
 * Called after every status transition. Removes widget when no agents are active.
 */
function updateBgWidget(): void {
	if (!uiSetWidget) return;

	const activeGroups = [...backgroundGroups.values()].filter((g) => g.status === "running");
	const activeSolo = [...backgroundAgents.values()].filter(
		(a) => !a.groupId && (a.status === "running" || a.status === "queued" || a.status === "waiting"),
	);
	const totalActive = activeGroups.length + activeSolo.length;

	if (totalActive === 0) {
		uiSetWidget("subagent-bg", undefined);
		if (bgWidgetInterval) {
			clearInterval(bgWidgetInterval);
			bgWidgetInterval = null;
		}
		return;
	}

	if (!bgWidgetInterval) {
		bgWidgetInterval = setInterval(updateBgWidget, 1000);
	}

	const lines: string[] = [];

	for (const g of activeGroups) {
		const elapsed = formatDuration((g.endTime ?? Date.now()) - g.startTime);
		if (g.mode === "parallel") {
			const members = g.memberIds.map((id) => backgroundAgents.get(id)).filter(Boolean) as BackgroundAgent[];
			const done = members.filter((m) => m.status === "done" || m.status === "error" || m.status === "aborted").length;
			lines.push(`  🔀 ${g.groupId} — ${done}/${members.length} done (${elapsed})`);
		} else {
			lines.push(`  🔗 ${g.groupId} — step ${(g.currentStepIndex ?? 0) + 1}/${g.chainSteps?.length ?? 0} (${elapsed})`);
		}
	}

	for (const a of activeSolo) {
		const elapsed = formatDuration((a.endTime ?? Date.now()) - a.startTime);
		const icon = a.status === "running" ? "🏃" : a.status === "waiting" ? "⏸️" : "📋";
		lines.push(`  ${icon} ${a.id} — ${a.status} (${elapsed})`);
	}

	lines.sort();
	uiSetWidget("subagent-bg", [`🤖 Background agents (${totalActive})`, ...lines]);
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/** Truncate a string to a maximum length, appending an ellipsis. */
function truncateText(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}…`;
}

/**
 * Build a structured conversation transcript for the agents panel right pane.
 *
 * Emits, in order: the initial prompt, then every turn — assistant text, tool
 * calls, and tool results — so the expanded view shows the agent's full history
 * rather than only its final reply. Tool results are capped so a single huge
 * result cannot dominate the pane.
 */
function buildTranscript(task: string, messages: Message[], resultLimit = 400): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];

	// Prefer the real user messages as the prompt entries — the agent's first
	// user message is the untruncated task (often `Task: <full text>`), while the
	// `task` argument is a truncated display string. Emitting both produced a
	// duplicate, truncated-then-full prompt. Only fall back to the synthetic
	// `task` entry when no user messages have been captured yet.
	let hasUserText = false;
	for (const msg of messages) {
		if (msg.role === "user") {
			const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
			for (const part of parts) {
				const text = typeof part === "string" ? part : part.type === "text" ? part.text : "";
				if (!text) continue;
				hasUserText = true;
				entries.push({ kind: "prompt", text });
			}
		} else if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					if (part.text.trim()) entries.push({ kind: "assistant", text: part.text });
				} else if (part.type === "toolCall") {
					const plain = formatToolCall(part.name, part.arguments, (_c, s) => s);
					entries.push({ kind: "tool", text: truncateText(plain, 120) });
				}
				// thinking parts are ignored
			}
		} else if (msg.role === "toolResult") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) {
					entries.push({ kind: "result", text: truncateText(part.text, resultLimit) });
				}
			}
		}
	}

	// No user messages captured yet (agent spawned but nothing streamed back):
	// fall back to the synthetic truncated task entry so the pane isn't blank.
	if (!hasUserText) {
		entries.unshift({ kind: "prompt", text: task });
	}

	return entries;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Resolve agent discovery for a tool invocation by funnelling the cwd/scope
 * fallback through a single pure seam. Project-local `.pi/agents` are
 * discovered relative to `params.cwd` (when supplied) so that a caller-provided
 * working directory wins over the host ctx cwd — this is what keeps
 * list_subagents / describe_agent / subagent discovery in sync.
 */
export function resolveScopeDiscovery(
	params: { cwd?: string; agentScope?: AgentScope },
	ctxCwd: string,
): AgentDiscoveryResult {
	return discoverAgents(params.cwd ?? ctxCwd, params.agentScope ?? "user");
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function childResources(agent: AgentConfig, extensions?: string[], mcps?: string[], cwd = process.cwd()) {
	const agentDir = getAgentDir();
	return {
		extensionPaths: resolveExtensionPaths(agentDir, [...new Set([...(agent.extensions ?? []), ...(extensions ?? [])])]),
		...(mcps?.length ? { mcpServers: loadScopedMcpServers(mcps, agentDir, cwd, resolveSdkProjectTrust(cwd, agentDir)) } : {}),
	};
}

async function runSingleAgent(
	defaultCwd: string,
	invocation: AgentInvocation,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const runId = `fg-${++foregroundAgentSeq}`;
	const controller = new AbortController();
	const abortFromParent = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abortFromParent, { once: true });

	const currentResult: SingleResult = {
		backend: "sdk",
		agent: invocation.agentName,
		agentSource: invocation.agent.source,
		task: invocation.display,
		promptKind: invocation.promptKind,
		input: invocation.input,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...buildResolvedModelMetadata(invocation.resolvedModel),
		step: invocation.step,
		startTime: Date.now(),
	};
	const emitUpdate = () => onUpdate?.({
		content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
		details: makeDetails([currentResult]),
	});
	const elapsedInterval = onUpdate ? setInterval(emitUpdate, 1000) : null;
	let child: SdkChild | undefined;
	let abortChild: (() => void) | undefined;

	foregroundAgents.set(runId, {
		id: runId, agentName: invocation.agentName, task: invocation.display,
		controller, startTime: Date.now(), lastEventAt: Date.now(), turns: 0, result: currentResult,
	});
	try {
		child = await createSdkChild({
			signal: controller.signal,
			cwd: invocation.cwd ?? defaultCwd,
			agent: invocation.agent,
			resolvedModel: invocation.resolvedModel,
			...childResources(invocation.agent, invocation.extensions, invocation.mcps, invocation.cwd ?? defaultCwd),
			onEvent(event) {
				const handle = foregroundAgents.get(runId);
				if (handle) handle.lastEventAt = Date.now();
				if (event.type === "tool_execution_start" && handle) handle.currentTool = event.toolName;
				if (event.type === "tool_execution_end" && handle) handle.currentTool = undefined;
				if (event.type !== "message_end") return;
				const msg = event.message as Message;
				currentResult.messages.push(msg);
				if (msg.role === "assistant") {
					currentResult.usage.turns++;
					if (handle) handle.turns = currentResult.usage.turns;
					const usage = msg.usage;
					if (usage) {
						currentResult.usage.input += usage.input || 0;
						currentResult.usage.output += usage.output || 0;
						currentResult.usage.cacheRead += usage.cacheRead || 0;
						currentResult.usage.cacheWrite += usage.cacheWrite || 0;
						currentResult.usage.cost += usage.cost?.total || 0;
						currentResult.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!currentResult.model && msg.model) currentResult.model = msg.model;
					if (!currentResult.provider && msg.provider) currentResult.provider = msg.provider;
					currentResult.stopReason = msg.stopReason;
					currentResult.errorMessage = msg.errorMessage;
				}
				emitUpdate();
			},
		});
		currentResult.model ||= child.session.model?.id;
		currentResult.provider ||= child.session.model?.provider;
		currentResult.contextWindow = child.session.model?.contextWindow;
		abortChild = () => { void child?.abort().catch(() => {}); };
		controller.signal.addEventListener("abort", abortChild, { once: true });
		if (controller.signal.aborted) throw new Error("Subagent was aborted");
		await child.prompt(invocation.prompt);
		currentResult.exitCode = 0;
		const stats = child.session.getSessionStats();
		currentResult.usage = {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			cost: stats.cost,
			contextTokens: stats.contextUsage?.tokens ?? currentResult.usage.contextTokens,
			turns: stats.assistantMessages,
		};
		if (controller.signal.aborted) throw new Error("Subagent was aborted");
		emitUpdate();
		return currentResult;
	} catch (error) {
		currentResult.exitCode = 1;
		const message = error instanceof Error ? error.message : String(error);
		currentResult.errorMessage = message;
		currentResult.stderr = message;
		if (controller.signal.aborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		foregroundAgents.delete(runId);
		signal?.removeEventListener("abort", abortFromParent);
		if (abortChild) controller.signal.removeEventListener("abort", abortChild);
		if (elapsedInterval) clearInterval(elapsedInterval);
		if (child) {
			try { await child.dispose(); }
			catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				currentResult.stderr += `\nSDK cleanup failed: ${message}`;
				currentResult.exitCode = 1;
				currentResult.errorMessage ||= message;
			}
		}
	}
}

// ── Background agent helpers ─────────────────────────────────────

const BG_SIGNAL_INSTRUCTION = `
You have a __bg_signal tool. You MUST call it when:
- Your task is complete: __bg_signal(status: "done", summary: "what you accomplished")
- You need input to continue: __bg_signal(status: "question", question: "what you need")
- You hit an unrecoverable error: __bg_signal(status: "error", error: "what went wrong")
Call __bg_signal as the ONLY tool in its turn. Do NOT forget to call __bg_signal(status: "done") when you finish your task.
`.trim();

function generateBgId(agentName: string, explicitId?: string): string {
	if (explicitId && !backgroundAgents.has(explicitId)) return explicitId;
	const counter = (bgAutoCounter.get(agentName) || 0) + 1;
	bgAutoCounter.set(agentName, counter);
	const id = `${agentName}-${counter}`;
	if (!backgroundAgents.has(id)) return id;
	return `${agentName}-${counter}-${Date.now().toString(36).slice(-4)}`;
}

function generateGroupId(mode: "parallel" | "chain", explicitId?: string): string {
	if (explicitId && !backgroundGroups.has(explicitId)) return explicitId;
	const prefix = mode === "parallel" ? "parallel" : "chain";
	const counter = (bgAutoCounter.get(prefix) || 0) + 1;
	bgAutoCounter.set(prefix, counter);
	return `${prefix}-${counter}`;
}

function generateMemberId(groupId: string, agentName: string, allAgentNames: string[]): string {
	const dupeCount = allAgentNames.filter((a) => a === agentName).length;
	if (dupeCount <= 1) return `${groupId}/${agentName}`;
	const existingMembers = [...backgroundAgents.keys()].filter((id) => id.startsWith(`${groupId}/${agentName}`));
	return `${groupId}/${agentName}-${existingMembers.length + 1}`;
}

function resolveId(id: string):
	| { type: "group"; group: BackgroundGroup }
	| { type: "agent"; agent: BackgroundAgent }
	| { type: "not_found" } {
	const group = backgroundGroups.get(id);
	if (group) return { type: "group", group };
	const agent = backgroundAgents.get(id);
	if (agent) return { type: "agent", agent };
	return { type: "not_found" };
}

function finishSdkBackgroundAgent(bgAgent: BackgroundAgent): void {
	bgAgent.setupController?.abort();
	if (bgAgent.status === "aborted") bgAgent.result.exitCode = 1;
	const child = bgAgent.sdk;
	if (!child) {
		// SDK creation may still be in flight; its launch callback will see the
		// terminal status and dispose the session before it can run a prompt.
		if (bgAgent.sdkReady) return;
		updateBgWidget();
		trySpawnQueued();
		return;
	}
	if (bgAgent.sdkCleanupStarted) return;
	bgAgent.sdkCleanupStarted = true;
	bgAgent.sdkCleanup = (async () => {
		try {
			await child.dispose();
		} catch (error) {
			bgAgent.result.stderr += `\nSDK cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			if (bgAgent.status === "aborted") bgAgent.result.exitCode = 1;
			bgAgent.sdk = undefined;
			bgAgent.sdkReady = undefined;
			updateBgWidget();
			trySpawnQueued();
		}
	})();
}

async function runSdkBackgroundPrompt(bgAgent: BackgroundAgent, prompt: string): Promise<void> {
	const child = bgAgent.sdk;
	if (!child) return;
	const runId = bgAgent.sdkRunId = (bgAgent.sdkRunId ?? 0) + 1;
	bgAgent.result.exitCode = -1;
	try {
		await child.prompt(prompt);
		if (runId !== bgAgent.sdkRunId || bgAgent.interrupting || bgAgent.status === "aborted" || bgAgent.status === "done" || bgAgent.status === "error") return;
		bgAgent.result.exitCode = 0;
		const stats = child.session.getSessionStats();
		bgAgent.result.usage = {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			cost: stats.cost,
			contextTokens: stats.contextUsage?.tokens ?? bgAgent.result.usage.contextTokens,
			turns: stats.assistantMessages,
		};
		const signal = child.takeSignal();
		const output = getFinalOutput(bgAgent.result.messages) || "(no output)";
		if (signal?.status === "done") {
			handleBgSignal(bgAgent, { status: "done", summary: signal.summary || output });
		} else if (signal?.status === "question") {
			handleBgSignal(bgAgent, { status: "question", question: signal.question || output });
		} else if (signal?.status === "error") {
			handleBgSignal(bgAgent, { status: "error", error: signal.error || output });
		} else {
			handleBgSignal(bgAgent, isSuccessfulResult(bgAgent.result)
				? { status: "done", summary: output }
				: { status: "error", error: bgAgent.result.errorMessage || output });
		}
	} catch (error) {
		if (runId !== bgAgent.sdkRunId || bgAgent.interrupting || bgAgent.status === "aborted") return;
		const message = error instanceof Error ? error.message : String(error);
		bgAgent.result.exitCode = 1;
		bgAgent.result.errorMessage = message;
		bgAgent.result.stderr += message;
		handleBgSignal(bgAgent, { status: "error", error: message });
	}
}

function launchBackgroundAgent(bgAgent: BackgroundAgent): void {
	bgAgent.status = "running";
	bgAgent.startTime = Date.now();
	bgAgent.lastEventAt = Date.now();
	bgAgent.result.backend = "sdk";
	bgAgent.setupController = new AbortController();
	updateBgWidget();

	bgAgent.sdkReady = Promise.resolve().then(() => createSdkChild({
		signal: bgAgent.setupController?.signal,
		cwd: bgAgent.cwd,
		agent: bgAgent.agentConfig,
		resolvedModel: bgAgent.resolvedModel ?? {
			model: bgAgent.result.resolvedModel,
			thinkingLevel: bgAgent.result.resolvedThinkingLevel,
			modelSource: bgAgent.result.configSource ?? "parent",
			source: bgAgent.result.configSource ?? "parent",
		},
		...childResources(bgAgent.agentConfig, bgAgent.extensions, bgAgent.mcps, bgAgent.cwd),
		backgroundInstruction: BG_SIGNAL_INSTRUCTION,
		onEvent(event) {
			bgAgent.lastEventAt = Date.now();
			if (event.type === "tool_execution_start") bgAgent.currentTool = event.toolName;
			if (event.type === "tool_execution_end") bgAgent.currentTool = undefined;
			if (event.type !== "message_end") return;
			const msg = event.message as Message;
			bgAgent.result.messages.push(msg);
			if (msg.role !== "assistant") return;
			bgAgent.result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				bgAgent.result.usage.input += usage.input || 0;
				bgAgent.result.usage.output += usage.output || 0;
				bgAgent.result.usage.cacheRead += usage.cacheRead || 0;
				bgAgent.result.usage.cacheWrite += usage.cacheWrite || 0;
				bgAgent.result.usage.cost += usage.cost?.total || 0;
				bgAgent.result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!bgAgent.result.model && msg.model) bgAgent.result.model = msg.model;
			if (!bgAgent.result.provider && msg.provider) bgAgent.result.provider = msg.provider;
			bgAgent.result.stopReason = msg.stopReason;
			bgAgent.result.errorMessage = msg.errorMessage;
		},
	}));
	void bgAgent.sdkReady.then((child) => {
		bgAgent.sdk = child;
		bgAgent.result.model ||= child.session.model?.id;
		bgAgent.result.provider ||= child.session.model?.provider;
		bgAgent.result.contextWindow = child.session.model?.contextWindow;
		if (bgAgent.status === "aborted") {
			finishSdkBackgroundAgent(bgAgent);
			return;
		}
		void runSdkBackgroundPrompt(bgAgent, bgAgent.prompt);
	}).catch((error) => {
		bgAgent.sdkReady = undefined;
		if (bgAgent.status === "aborted") {
			finishSdkBackgroundAgent(bgAgent);
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		bgAgent.result.exitCode = 1;
		bgAgent.result.errorMessage = message;
		bgAgent.result.stderr += message;
		handleBgSignal(bgAgent, { status: "error", error: message });
	});

	if (!bgAgent.groupId) {
		piRef?.sendMessage({
			customType: "subagent-bg",
			content: `[🚀 STARTED ${bgAgent.id}] ${bgAgent.agent} — ${bgAgent.task.slice(0, 100)}`,
			display: true,
		}, { triggerTurn: false });
	}
}

export function handleBgSignal(bgAgent: BackgroundAgent, args: Record<string, string>): void {
	// A parsed done tool call cannot overrule the same message's terminal failure.
	if (args.status === "done" && hasTerminalFailure(bgAgent.result)) {
		args = { status: "error", error: bgAgent.result.errorMessage || `Model ended with ${bgAgent.result.stopReason}` };
	}
	const signalStatus = args.status as "done" | "question" | "error" | undefined;
	const summary = args.summary || args.question || args.error || "";

	if (signalStatus === "done") {
		bgAgent.result.completionSignal = "done";
		bgAgent.status = "done";
		bgAgent.endTime = Date.now();
		appendBgUsageEntry(bgAgent, signalStatus);
		const group = bgAgent.groupId ? backgroundGroups.get(bgAgent.groupId) : undefined;
		if (!group) {
			piRef?.sendMessage(
				{
					customType: "subagent-bg",
					content: `[✅ DONE from ${bgAgent.id}] ${summary.slice(0, 300)}`,
					display: true,
				},
				{ triggerTurn: true },
			);
			if (bgAgent.teamName && bgAgent.saveAs) {
				const output = getFinalOutput(bgAgent.result.messages);
				if (output) {
					saveOutput(bgAgent.teamName, bgAgent.saveAs, output);
					bgAgent.result.savedAs = bgAgent.saveAs;
				}
			}
		}
		killBgProcess(bgAgent);

		// V2: Group completion check
		if (group) {
			const output = summary || getFinalOutput(bgAgent.result.messages);
			if (group.mode === "chain") {
				group.previousOutput = output;
			}
			if (bgAgent.teamName && bgAgent.saveAs && output) {
				saveOutput(bgAgent.teamName, bgAgent.saveAs, output);
				bgAgent.result.savedAs = bgAgent.saveAs;
			}
			if (group.notifyPerTask) {
				const stepInfo = group.mode === "chain"
					? `Step ${(group.currentStepIndex ?? 0) + 1}/${group.chainSteps?.length ?? 0} done: ${bgAgent.agent}`
					: `${bgAgent.id}`;
				piRef?.sendMessage(
					{ customType: "subagent-bg", content: `[✅ ${group.mode === "chain" ? group.groupId : bgAgent.id}] ${stepInfo} — ${summary.slice(0, 200)}`, display: true },
					{ triggerTurn: false },
				);
			}
			if (group.mode === "chain") {
				advanceChain(group);
			} else {
				checkParallelGroupCompletion(group);
			}
			trySpawnQueued();
			updateBgWidget();
			return;
		}

		updateBgWidget();
	} else if (signalStatus === "question") {
		bgAgent.status = "waiting";
		piRef?.sendMessage(
			{
				customType: "subagent-bg",
				content: `[❓ QUESTION from ${bgAgent.id}] ${summary.slice(0, 300)}`,
				display: true,
			},
			{ triggerTurn: true },
		);
		updateBgWidget();
	} else if (signalStatus === "error") {
		bgAgent.result.completionSignal = "error";
		bgAgent.status = "error";
		bgAgent.endTime = Date.now();
		appendBgUsageEntry(bgAgent, signalStatus);
		const group = bgAgent.groupId ? backgroundGroups.get(bgAgent.groupId) : undefined;
		if (!group) {
			piRef?.sendMessage(
				{
					customType: "subagent-bg",
					content: `[❌ ERROR from ${bgAgent.id}] ${summary.slice(0, 300)}`,
					display: true,
				},
				{ triggerTurn: true },
			);
		}
		killBgProcess(bgAgent);

		// V2: Group error handling
		if (group) {
			if (group.notifyPerTask || group.mode === "chain") {
				piRef?.sendMessage(
					{ customType: "subagent-bg", content: `[❌ ${group.groupId}] ${bgAgent.id} failed: ${summary.slice(0, 200)}`, display: true },
					{ triggerTurn: group.mode === "chain" },
				);
			}
			if (group.mode === "chain") {
				group.status = "error";
				group.endTime = Date.now();
				piRef?.sendMessage(
					{ customType: "subagent-bg", content: `[❌ ${group.groupId}] Step ${(group.currentStepIndex ?? 0) + 1}/${group.chainSteps?.length ?? 0} failed: ${bgAgent.agent} — chain stopped`, display: true },
					{ triggerTurn: true },
				);
				for (const mid of group.memberIds) {
					const m = backgroundAgents.get(mid);
					if (m && m.status === "queued") {
						m.status = "aborted";
						m.endTime = Date.now();
					}
				}
			} else {
				checkParallelGroupCompletion(group);
			}
			trySpawnQueued();
			updateBgWidget();
			return;
		}

		updateBgWidget();
	}
}

function checkParallelGroupCompletion(group: BackgroundGroup): void {
	const members = group.memberIds.map((id) => backgroundAgents.get(id)).filter(Boolean) as BackgroundAgent[];
	const allDone = members.every((m) => m.status === "done" || m.status === "error" || m.status === "aborted");
	if (!allDone) return;

	const succeeded = members.filter((m) => m.status === "done").length;
	const failed = members.filter((m) => m.status === "error" || m.status === "aborted").length;

	group.status = failed > 0 ? (succeeded > 0 ? "done" : "error") : "done";
	group.endTime = Date.now();

	const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	for (const m of members) {
		totalUsage.input += m.result.usage.input;
		totalUsage.output += m.result.usage.output;
		totalUsage.cacheRead += m.result.usage.cacheRead;
		totalUsage.cacheWrite += m.result.usage.cacheWrite;
		totalUsage.cost += m.result.usage.cost;
		totalUsage.contextTokens += m.result.usage.contextTokens;
		totalUsage.turns += m.result.usage.turns;
	}
	piRef?.appendEntry("subagent-bg-usage", {
		id: group.groupId,
		type: "group",
		mode: "parallel",
		status: group.status,
		members: group.memberIds.length,
		succeeded,
		failed,
		usage: totalUsage,
		elapsedMs: group.endTime - group.startTime,
	});

	const icon = failed > 0 ? "⚠️" : "✅";
	const msg = `[${icon} GROUP DONE: ${group.groupId}] ${succeeded}/${members.length} succeeded${failed > 0 ? `, ${failed} failed` : ""}`;
	piRef?.sendMessage({ customType: "subagent-bg", content: msg, display: true }, { triggerTurn: true });

	evictCompletedGroups();
	updateBgWidget();
}

function advanceChain(group: BackgroundGroup): void {
	if (!group.chainSteps || group.currentStepIndex === undefined || !group.agents) return;

	const nextIndex = group.currentStepIndex + 1;
	if (nextIndex >= group.chainSteps.length) {
		group.status = "done";
		group.endTime = Date.now();

		const members = group.memberIds.map((id) => backgroundAgents.get(id)).filter(Boolean) as BackgroundAgent[];
		const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
		for (const m of members) {
			totalUsage.input += m.result.usage.input;
			totalUsage.output += m.result.usage.output;
			totalUsage.cacheRead += m.result.usage.cacheRead;
			totalUsage.cacheWrite += m.result.usage.cacheWrite;
			totalUsage.cost += m.result.usage.cost;
			totalUsage.contextTokens += m.result.usage.contextTokens;
			totalUsage.turns += m.result.usage.turns;
		}
		piRef?.appendEntry("subagent-bg-usage", {
			id: group.groupId,
			type: "group",
			mode: "chain",
			status: "done",
			steps: group.chainSteps.length,
			usage: totalUsage,
			elapsedMs: group.endTime - group.startTime,
		});

		piRef?.sendMessage(
			{ customType: "subagent-bg", content: `[✅ CHAIN DONE: ${group.groupId}] All ${group.chainSteps.length} steps completed`, display: true },
			{ triggerTurn: true },
		);
		evictCompletedGroups();
		updateBgWidget();
		return;
	}

	group.currentStepIndex = nextIndex;
	const stepDef = group.chainSteps[nextIndex];

	let invocation: AgentInvocation;
	try {
		// Use stored agents, or fallback to discovery (ideally we just use group.agents)
		invocation = resolveInvocation({
			agents: group.agents,
			spec: stepDef,
			teamName: group.teamName,
			previousOutput: group.previousOutput || "",
			step: nextIndex + 1,
			resolvedModel: stepDef.resolvedModel,
		});
	} catch (e: any) {
		group.status = "error";
		group.endTime = Date.now();
		piRef?.sendMessage(
			{ customType: "subagent-bg", content: `[❌ ${group.groupId}] Step ${nextIndex + 1}/${group.chainSteps.length} failed: ${e.message}`, display: true },
			{ triggerTurn: true },
		);
		updateBgWidget();
		return;
	}

	const agentConfig = invocation.agent;
	const memberId = generateMemberId(group.groupId, stepDef.agent, group.chainSteps.map((s) => s.agent));

	const bgAgent: BackgroundAgent = {
		id: memberId,
		agent: stepDef.agent,
		task: invocation.display,
		prompt: invocation.prompt,
		promptKind: invocation.promptKind,
		input: invocation.input,
		result: {
			agent: stepDef.agent,
			agentSource: agentConfig.source,
			task: invocation.display,
			promptKind: invocation.promptKind,
			input: invocation.input,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			...buildResolvedModelMetadata(stepDef.resolvedModel),
			startTime: Date.now(),
		},
		status: "queued",
		startTime: Date.now(),
		cwd: stepDef.cwd ?? group.defaultCwd ?? process.cwd(),
		resolvedModel: stepDef.resolvedModel,
		agentConfig,
		teamName: group.teamName,
		saveAs: stepDef.saveAs || stepDef.agent,
		extensions: stepDef.extensions,
		mcps: stepDef.mcps,
		groupId: group.groupId,
	};

	group.memberIds.push(memberId);
	backgroundAgents.set(memberId, bgAgent);

	if (group.notifyPerTask) {
		piRef?.sendMessage(
			{ customType: "subagent-bg", content: `[🔗 ${group.groupId}] Step ${nextIndex + 1}/${group.chainSteps.length} started: ${stepDef.agent}`, display: true },
			{ triggerTurn: false },
		);
	}

	const runningCount = [...backgroundAgents.values()].filter((a) => a.status === "running" || a.status === "waiting").length;
	if (runningCount < MAX_PARALLEL_AGENTS) {
		bgAgent.status = "running";
		launchBackgroundAgent(bgAgent);
	}

	updateBgWidget();
}

function evictCompletedGroups(): void {
	const completed = [...backgroundGroups.entries()]
		.filter(([_, g]) => g.status === "done" || g.status === "error" || g.status === "aborted")
		.sort((a, b) => (a[1].endTime || 0) - (b[1].endTime || 0));
	while (completed.length > MAX_COMPLETED_RETENTION) {
		const [id] = completed.shift()!;
		backgroundGroups.delete(id);
	}
}

function launchBackgroundParallel(
	params: { tasks: Array<{ agent: string; task?: string; input?: unknown; model?: string; thinkingLevel?: SubagentThinkingLevel; cwd?: string; saveAs?: string; mcps?: string[]; extensions?: string[] }>; saveAs?: string; notifyPerTask?: boolean; background?: boolean },
	defaultCwd: string,
	teamName: string | undefined,
	invocations: AgentInvocation[],
): { groupId: string; memberIds: string[]; queuedCount: number } {
	const groupId = generateGroupId("parallel", params.saveAs);
	const notifyPerTask = params.notifyPerTask !== false;
	const allAgentNames = params.tasks.map((t) => t.agent);

	const group: BackgroundGroup = {
		groupId,
		mode: "parallel",
		memberIds: [],
		status: "running",
		startTime: Date.now(),
		notifyPerTask,
		teamName,
		saveAs: params.saveAs,
	};
	backgroundGroups.set(groupId, group);

	let queuedCount = 0;

	for (let i = 0; i < params.tasks.length; i++) {
		const t = params.tasks[i];
		const invocation = invocations[i];
		const agentConfig = invocation.agent;

		const memberId = generateMemberId(groupId, t.agent, allAgentNames);

		const runningCount = [...backgroundAgents.values()].filter((a) => a.status === "running" || a.status === "waiting").length;
		const initialStatus = runningCount >= MAX_PARALLEL_AGENTS ? "queued" as const : "running" as const;
		if (initialStatus === "queued") queuedCount++;

		const bgAgent: BackgroundAgent = {
			id: memberId,
			agent: t.agent,
			task: invocation.display,
			prompt: invocation.prompt,
			promptKind: invocation.promptKind,
			input: invocation.input,
			result: {
				agent: t.agent,
				agentSource: agentConfig.source,
				task: invocation.display,
				promptKind: invocation.promptKind,
				input: invocation.input,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				...buildResolvedModelMetadata(invocation.resolvedModel),
				startTime: Date.now(),
			},
			status: initialStatus,
			startTime: Date.now(),
			cwd: t.cwd ?? defaultCwd,
			resolvedModel: invocation.resolvedModel,
			agentConfig,
			teamName,
			saveAs: t.saveAs || t.agent,
			extensions: t.extensions,
			mcps: t.mcps,
			groupId,
		};

		group.memberIds.push(memberId);
		backgroundAgents.set(memberId, bgAgent);

		if (initialStatus === "running") {
			launchBackgroundAgent(bgAgent);
		}
	}

	evictCompletedAgents();
	evictCompletedGroups();

	const agentNames = params.tasks.map((t) => t.agent).join(", ");
	piRef?.sendMessage(
		{ customType: "subagent-bg", content: `[🔀 STARTED ${groupId}] ${params.tasks.length} tasks: ${agentNames}`, display: true },
		{ triggerTurn: false },
	);

	updateBgWidget();
	return { groupId, memberIds: group.memberIds, queuedCount };
}

function launchBackgroundChain(
	params: { chain: Array<{ agent: string; task?: string; input?: unknown; model?: string; thinkingLevel?: SubagentThinkingLevel; cwd?: string; saveAs?: string; mcps?: string[]; extensions?: string[] }>; saveAs?: string; notifyPerTask?: boolean; background?: boolean },
	agents: AgentConfig[],
	defaultCwd: string,
	teamName: string | undefined,
	firstInvocation: AgentInvocation,
	stepResolvedModels: ResolvedModelConfig[],
): { groupId: string; firstMemberId: string } {
	if (stepResolvedModels.length !== params.chain.length) {
		throw new Error(
			`Internal invariant violated: background chain received ${params.chain.length} steps but ${stepResolvedModels.length} resolved models.`,
		);
	}
	const chainSteps = params.chain.map((step, index): ChainStepDef => {
		const resolvedModel = stepResolvedModels[index];
		if (!resolvedModel) {
			throw new Error(
				`Internal invariant violated: missing resolved model for background chain step ${index + 1} (${step.agent}).`,
			);
		}

		return {
			agent: step.agent,
			task: step.task,
			input: step.input,
			cwd: step.cwd,
			saveAs: step.saveAs,
			mcps: step.mcps,
			extensions: step.extensions,
			resolvedModel,
		};
	});
	const groupId = generateGroupId("chain", params.saveAs);
	const notifyPerTask = params.notifyPerTask !== false;
	const allAgentNames = params.chain.map((s) => s.agent);

	const group: BackgroundGroup = {
		groupId,
		mode: "chain",
		memberIds: [],
		status: "running",
		startTime: Date.now(),
		chainSteps,
		currentStepIndex: 0,
		notifyPerTask,
		teamName,
		saveAs: params.saveAs,
		agents, // store for advanceChain
		defaultCwd,
	};
	backgroundGroups.set(groupId, group);

	const firstStep = params.chain[0];
	const invocation = firstInvocation;
	const agentConfig = invocation.agent;

	const memberId = generateMemberId(groupId, firstStep.agent, allAgentNames);

	const runningCount = [...backgroundAgents.values()].filter((a) => a.status === "running" || a.status === "waiting").length;
	const initialStatus = runningCount >= MAX_PARALLEL_AGENTS ? "queued" as const : "running" as const;

	const bgAgent: BackgroundAgent = {
		id: memberId,
		agent: firstStep.agent,
		task: invocation.display,
		prompt: invocation.prompt,
		promptKind: invocation.promptKind,
		input: invocation.input,
		result: {
			agent: firstStep.agent,
			agentSource: agentConfig.source,
			task: invocation.display,
			promptKind: invocation.promptKind,
			input: invocation.input,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			...buildResolvedModelMetadata(invocation.resolvedModel),
			startTime: Date.now(),
		},
		status: initialStatus,
		startTime: Date.now(),
		cwd: firstStep.cwd ?? defaultCwd,
		resolvedModel: invocation.resolvedModel,
		agentConfig,
		teamName,
		saveAs: firstStep.saveAs || firstStep.agent,
		extensions: firstStep.extensions,
		mcps: firstStep.mcps,
		groupId,
	};

	group.memberIds.push(memberId);
	backgroundAgents.set(memberId, bgAgent);
	evictCompletedAgents();
	evictCompletedGroups();

	if (initialStatus === "running") {
		launchBackgroundAgent(bgAgent);
	}

	piRef?.sendMessage(
		{ customType: "subagent-bg", content: `[🔗 STARTED ${groupId}] ${params.chain.length} steps, starting: ${firstStep.agent}`, display: true },
		{ triggerTurn: false },
	);

	updateBgWidget();
	return { groupId, firstMemberId: memberId };
}

function killBgProcess(bgAgent: BackgroundAgent): void {
	finishSdkBackgroundAgent(bgAgent);
}

function appendBgUsageEntry(bgAgent: BackgroundAgent, status: BackgroundAgent["status"]): void {
	piRef?.appendEntry("subagent-bg-usage", {
		id: bgAgent.id,
		agent: bgAgent.agent,
		status,
		usage: bgAgent.result.usage,
		model: bgAgent.result.model,
		provider: bgAgent.result.provider,
		elapsedMs: (bgAgent.endTime ?? Date.now()) - bgAgent.startTime,
	});
}

function trySpawnQueued(): void {
	const runningCount = [...backgroundAgents.values()].filter(
		(a) => a.status === "running" || a.status === "waiting",
	).length;

	if (runningCount >= MAX_PARALLEL_AGENTS) return;

	// Find first queued agent
	for (const bgAgent of backgroundAgents.values()) {
		if (bgAgent.status === "queued") {
			launchBackgroundAgent(bgAgent);
			break; // Only start one at a time; close handler will call trySpawnQueued again
		}
	}
}

function evictCompletedAgents(): void {
	const completed = [...backgroundAgents.entries()]
		.filter(([_, a]) => a.status === "done" || a.status === "error" || a.status === "aborted")
		.sort((a, b) => (a[1].endTime || 0) - (b[1].endTime || 0));

	while (completed.length > MAX_COMPLETED_RETENTION) {
		const [id] = completed.shift()!;
		backgroundAgents.delete(id);
	}
}

async function shutdownAllBackgroundAgents(): Promise<void> {
	const sdkCleanups: Promise<void>[] = [];
	for (const bgAgent of backgroundAgents.values()) {
		const ready = bgAgent.sdkReady;
		sdkCleanups.push((async () => {
			try { await ready; } catch { /* setup failure is handled by the launcher */ }
			await bgAgent.sdkCleanup;
		})());
		if (bgAgent.status === "running" || bgAgent.status === "waiting") {
			bgAgent.status = "aborted";
			bgAgent.endTime = Date.now();
			killBgProcess(bgAgent);
			// Save partial output in team mode
			if (bgAgent.teamName && bgAgent.saveAs) {
				const output = getFinalOutput(bgAgent.result.messages);
				if (output) {
					try { saveOutput(bgAgent.teamName, bgAgent.saveAs, output); } catch { /* ignore */ }
				}
			}
		} else if (bgAgent.status === "queued") {
			bgAgent.status = "aborted";
			bgAgent.endTime = Date.now();
		}
	}
	backgroundAgents.clear();
	// V2: Clean up groups
	for (const group of backgroundGroups.values()) {
		if (group.status === "running") {
			group.status = "aborted";
			group.endTime = Date.now();
		}
	}
	backgroundGroups.clear();
	updateBgWidget();
	await Promise.allSettled(sdkCleanups);
}

const SubagentThinkingLevelSchema = StringEnum(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
	{ description: "Reasoning level for the selected subagent model" },
);

function invocationModelOverrideProperties(modelDescription: string) {
	return {
		model: Type.Optional(Type.String({ description: modelDescription })),
		thinkingLevel: Type.Optional(SubagentThinkingLevelSchema),
	};
}

function createTaskItem(allowInvocationModelOverrides: boolean) {
	return Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.Optional(Type.String({ description: "Task to delegate to the agent" })),
		input: Type.Optional(Type.Unknown({ description: "Structured input for parameterized agents" })),
		...(allowInvocationModelOverrides
			? invocationModelOverrideProperties("Model override for this task")
			: {}),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		saveAs: Type.Optional(
			Type.String({ description: "Name for saved output in team mode (default: agent name, or agent-N for parallel)" }),
		),
		mcps: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"MCP server names this agent needs (e.g. [\"my-mcp\", \"other-mcp\"]). " +
					"Only these MCPs are loaded. Omit for no MCPs (fastest). Requires team mode.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Extension names this agent needs (e.g. [\"my-ext\", \"other-ext\"]). " +
					"Only these extensions are loaded. Merged with agent's frontmatter extensions. Omit for none.",
			}),
		),
	});
}

function createChainItem(allowInvocationModelOverrides: boolean) {
	return Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.Optional(Type.String({ description: "Task with optional {previous} placeholder for prior output" })),
		input: Type.Optional(Type.Unknown({ description: "Structured input for parameterized agents. String values support {previous}." })),
		...(allowInvocationModelOverrides
			? invocationModelOverrideProperties("Model override for this chain step")
			: {}),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		saveAs: Type.Optional(
			Type.String({ description: "Name for saved output in team mode (default: agent name)" }),
		),
		mcps: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"MCP server names this agent needs (e.g. [\"my-mcp\", \"other-mcp\"]). " +
					"Only these MCPs are loaded. Omit for no MCPs (fastest). Requires team mode.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Extension names this agent needs (e.g. [\"my-ext\", \"other-ext\"]). " +
					"Only these extensions are loaded. Merged with agent's frontmatter extensions. Omit for none.",
			}),
		),
	});
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const AgentDiscoveryParams = Type.Object({
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Directory used to discover project-local .pi/agents. Defaults to current cwd." })),
});

const DescribeAgentParams = Type.Object({
	agent: Type.String({ description: "Agent name to describe" }),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Directory used to discover project-local .pi/agents. Defaults to current cwd." })),
});

function createSubagentParams(allowInvocationModelOverrides: boolean) {
	return Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
		task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
		input: Type.Optional(Type.Unknown({ description: "Structured input for single mode" })),
		...(allowInvocationModelOverrides
			? invocationModelOverrideProperties("Invocation-wide model override")
			: {}),
		tasks: Type.Optional(Type.Array(createTaskItem(allowInvocationModelOverrides), { description: "Array of {agent, task/input} for parallel execution" })),
		chain: Type.Optional(Type.Array(createChainItem(allowInvocationModelOverrides), { description: "Array of {agent, task/input} for sequential execution" })),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode) and root used to discover project-local .pi/agents. Defaults to current cwd." })),
		team: Type.Optional(
			Type.String({
				description:
					"Team name for persistent coordination. Enables shared context (from ~/.pi/teams/{name}/shared_context.md), " +
					"named outputs saved to ~/.pi/teams/{name}/outputs/, and {output:name} placeholders in tasks.",
			}),
		),
		saveAs: Type.Optional(
			Type.String({ description: "Name for saved output in team mode (single mode only, default: agent name)" }),
		),
		mcps: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"MCP server names this agent needs (e.g. [\"my-mcp\", \"other-mcp\"]). " +
					"Only these MCPs are loaded. Omit for no MCPs (fastest). Requires team mode.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Extension names this agent needs (e.g. [\"my-ext\", \"other-ext\"]). " +
					"Only these extensions are loaded. Merged with agent's frontmatter extensions. Omit for none.",
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Run the agent in background (non-blocking). Returns immediately with a job ID. " +
					"Use subagent_status to check progress, subagent_steer to send messages, subagent_stop to kill. " +
					"Supports single, parallel, and chain modes.",
				default: false,
			}),
		),
		notifyPerTask: Type.Optional(
			Type.Boolean({
				description: "Fire per-task notifications for background parallel/chain (default: true). Set false for group-only completion notifications.",
				default: true,
			}),
		),
	});
}

const SubagentParams = createSubagentParams(true);

export function buildSubagentParams(
	allowInvocationModelOverrides: boolean,
): typeof SubagentParams {
	return allowInvocationModelOverrides
		? SubagentParams
		: createSubagentParams(false);
}

export interface SubagentExtensionOptions {
	settings?: SubagentSettings;
	settingsPath?: string;
}

export default function (
	pi: ExtensionAPI,
	options: SubagentExtensionOptions = {},
) {
	const loadedSettings = options.settings === undefined
		? loadSubagentSettings(options.settingsPath)
		: {
				settings: options.settings,
				path: options.settingsPath ?? "<injected subagent settings>",
				error: undefined,
			};
	if (loadedSettings.error !== undefined) {
		throw new Error(loadedSettings.error);
	}
	const allowInvocationModelOverrides =
		loadedSettings.settings.allowInvocationModelOverrides;
	const subagentParams = buildSubagentParams(allowInvocationModelOverrides);
	piRef = pi;
	// Register team coordination tools (TeamCreate, TaskCreate, SendMessage, etc.)
	registerCoordinationTools(pi);
	registerAgentModelCommand(pi, {
		// Security boundary: deliberately exclude repo-controlled project agents;
		// /agent-model manages personal user/bundled defaults, not project policy.
		discover: (ctx) =>
			resolveScopeDiscovery({ agentScope: "user" }, ctx.cwd).agents,
		getSessionOverrides: () => sessionModelOverrides,
		setSessionOverride(agent, override) {
			const updated = computeUpdatedOverrides(
				sessionModelOverrides,
				agent,
				override,
			);
			appendSessionOverridesSnapshot(pi.appendEntry.bind(pi), updated);
			sessionModelOverrides = updated;
		},
		loadGlobal: loadGlobalConfig,
		persistAgentModel: persistAgentModelFile,
		forceResetGlobal: forceResetGlobalConfig,
		makePort: makeCatalogPort,
		parentFor: parentModelForContext,
		buildEffectiveConfig,
	});

	// Capture UI context for widget updates
	pi.on("session_start", (_event, ctx) => {
		sessionModelOverrides = restoreSessionOverrides(ctx.sessionManager.getBranch());
		if (ctx.hasUI) {
			uiSetWidget = ctx.ui.setWidget.bind(ctx.ui);
		}
	});

	pi.registerTool({
		name: "list_subagents",
		label: "List Subagents",
		description: "Discover available subagents compactly. Use agentScope: 'both' to see project-local agents.",
		parameters: AgentDiscoveryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.agentScope ?? "user";
			const discovery = resolveScopeDiscovery(params, ctx.cwd);
			const {
				config: globalModelConfig,
				error: globalModelConfigError,
			} = loadGlobalConfig();
			const parentModelOverride = parentModelForContext(ctx);

			const agents = [...discovery.agents].sort((a, b) => a.name.localeCompare(b.name));
			const compactAgents = agents.map((agent) => {
				const effective = buildEffectiveConfig(agent, {
					session: sessionModelOverrides[agent.name],
					global: globalModelConfig[agent.name],
					parent: parentModelOverride,
				});
				return {
					...buildCompactAgentInfo(agent),
					effective: {
						model: effective.model,
						thinkingLevel: effective.thinkingLevel,
						source: effective.source,
					},
				};
			});
			const diagnostics = [...discovery.diagnostics];
			if (globalModelConfigError !== undefined) {
				diagnostics.push(globalModelConfigError);
			}
			const payload = {
				agentScope: scope,
				count: compactAgents.length,
				agents: compactAgents,
				diagnostics,
			};

			return {
				content: [{ type: "text", text: formatJson(payload) }],
				details: payload,
			};
		},
	});

	pi.registerTool({
		name: "describe_agent",
		label: "Describe Agent",
		description: "Get the full contract for a specific parameterized or freeform agent, including its JSON Schema.",
		parameters: DescribeAgentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.agentScope ?? "user";
			const discovery = resolveScopeDiscovery(params, ctx.cwd);
			const {
				config: globalModelConfig,
				error: globalModelConfigError,
			} = loadGlobalConfig();
			const parentModelOverride = parentModelForContext(ctx);

			const agent = discovery.agents.find(a => a.name === params.agent);
			if (!agent) {
				const available = discovery.agents.map(a => a.name).join(", ");
				const hint = scope !== "both" ? ` Try list_subagents({ agentScope: "both" }) if this may be project-local.` : "";
				throw new Error(`Agent "${params.agent}" not found.${hint} Available agents: ${available}`);
			}

			const effective = buildEffectiveConfig(agent, {
				session: sessionModelOverrides[agent.name],
				global: globalModelConfig[agent.name],
				parent: parentModelOverride,
			});
			const payload = {
				...buildFullAgentContract(agent),
				effective: {
					model: effective.model,
					thinkingLevel: effective.thinkingLevel,
					source: effective.source,
				},
				...(globalModelConfigError === undefined
					? {}
					: { configError: globalModelConfigError }),
			};
			return {
				content: [{ type: "text", text: formatJson(payload) }],
				details: payload,
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task/input), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
			"Team mode: set team param to enable shared context + named outputs. Use {output:name} in tasks to reference previous agent outputs.",
			"Manage teams: /team new|info|outputs|delete <name>.",
			"For parameterized agents, use list_subagents() and describe_agent() to get the schema, and pass the data via the `input` parameter.",
			...(allowInvocationModelOverrides
				? []
				: ["Per-invocation model and reasoning overrides are disabled; configured defaults are used."]),
		].join(" "),
		parameters: subagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			assertInvocationModelOverridesAllowed(
				params,
				allowInvocationModelOverrides,
				loadedSettings.path,
			);
			const {
				config: globalModelConfig,
				error: globalModelConfigError,
			} = loadGlobalConfig();
			if (globalModelConfigError !== undefined) throw new Error(formatGlobalConfigDispatchError(globalModelConfigError));
			const catalogPort = makeCatalogPort(ctx);
			const invocationModelOverride: AgentModelOverride = {
				model: params.model,
				thinkingLevel: params.thinkingLevel,
			};
			const parentModelOverride = parentModelForContext(ctx);
			const modelResolutionFor = (agentName: string) =>
				buildModelResolution(
					agentName,
					invocationModelOverride,
					globalModelConfig[agentName],
					parentModelOverride,
				);

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = resolveScopeDiscovery(params, ctx.cwd);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const teamName = params.team || undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && (params.task !== undefined || params.input !== undefined));
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			// Ensure team directory exists if team mode is active
			if (teamName) ensureTeamDir(teamName);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					team: teamName,
					results,
				});

			if (modeCount !== 1) {
				throw new Error(`Invalid parameters. Provide exactly one mode (single agent, chain, or tasks).`);
			}

			// Preflight confirm project agents
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const canPromptLocally =
						ctx.hasUI &&
						process.stdin.isTTY === true &&
						process.stdout.isTTY === true &&
						process.stdin.isRaw === true;

					if (!canPromptLocally) {
						throw new Error(`Execution of project-local agents requires explicit opt-in in headless/API mode.\n\nAgents: ${projectAgentsRequested.map(a => a.name).join(", ")}\n\nProject-local agents require local TUI confirmation or explicit caller opt-in.\nIn RPC/API/headless contexts, the caller must run its own confirmation and pass\n\`confirmProjectAgents: false\`. ctx.hasUI is not treated as human consent because\nPi's RPC UI protocol can be auto-answered by clients.`);
					}
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (hasTasks) {
				if (params.tasks!.length > MAX_PARALLEL_AGENTS) {
					throw new Error(`Too many parallel agents (${params.tasks!.length}). Max is ${MAX_PARALLEL_AGENTS}.`);
				}
			}

			// ── V2: Background parallel ──
			if (params.background && hasTasks) {
				const invocations = params.tasks!.map((t) =>
					resolveInvocation({
						agents,
						spec: t,
						teamName,
						modelResolution: modelResolutionFor(t.agent),
					}),
				);
				preflightValidateInvocations(invocations, catalogPort, ctx.cwd);
				const { groupId, memberIds, queuedCount } = launchBackgroundParallel(
					{ tasks: params.tasks!, saveAs: params.saveAs, notifyPerTask: params.notifyPerTask },
					ctx.cwd, teamName,
					invocations,
				);
				const runningCount = memberIds.length - queuedCount;
				return {
					content: [{
						type: "text",
						text: `Background parallel group started: ${groupId}\n` +
							`Members: ${memberIds.join(", ")}\n` +
							`Status: ${runningCount} running, ${queuedCount} queued\n` +
							`Use subagent_status(id: "${groupId}") to check progress.`,
					}],
					details: makeDetails("parallel")([]),
				};
			}

			// ── V2: Background chain ──
			if (params.background && hasChain) {
				// Preflight all steps with empty previousOutput to catch early errors
				const preflightInvocations = params.chain!.map((step) =>
					resolveInvocation({
						agents,
						spec: step,
						teamName,
						previousOutput: "",
						isPreflight: true,
						modelResolution: modelResolutionFor(step.agent),
					}),
				);
				preflightValidateInvocations(preflightInvocations, catalogPort, ctx.cwd);
				const stepResolvedModels = preflightInvocations.map(
					(invocation) => invocation.resolvedModel,
				);

				const firstInvocation = resolveInvocation({
					agents,
					spec: params.chain![0],
					teamName,
					resolvedModel: stepResolvedModels[0],
				});
				const { groupId, firstMemberId } = launchBackgroundChain(
					{ chain: params.chain!, saveAs: params.saveAs, notifyPerTask: params.notifyPerTask },
					agents, ctx.cwd, teamName,
					firstInvocation,
					stepResolvedModels,
				);
				return {
					content: [{
						type: "text",
						text: `Background chain started: ${groupId}\n` +
							`Steps: ${params.chain!.map((s) => s.agent).join(" → ")}\n` +
							`First step: ${firstMemberId || "(failed to start)"}\n` +
							`Use subagent_status(id: "${groupId}") to check progress.`,
					}],
					details: makeDetails("chain")([]),
				};
			}

			if (params.chain && params.chain.length > 0) {
				// Preflight all steps
				const preflightInvocations = params.chain.map((step) =>
					resolveInvocation({
						agents,
						spec: step,
						teamName,
						previousOutput: "",
						isPreflight: true,
						modelResolution: modelResolutionFor(step.agent),
					}),
				);
				preflightValidateInvocations(preflightInvocations, catalogPort, ctx.cwd);

				const results: SingleResult[] = [];
				let previousOutput: string | undefined = undefined;

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const invocation = resolveInvocation({
						agents,
						spec: step,
						teamName,
						previousOutput,
						step: i + 1,
						modelResolution: modelResolutionFor(step.agent),
					});

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd, invocation, signal, chainUpdate, makeDetails("chain"),
					);
					results.push(result);

					const isError =
						!isSuccessfulResult(result);
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);

					// Team mode: save named output
					if (teamName && previousOutput) {
						const outputName = step.saveAs || step.agent;
						saveOutput(teamName, outputName, previousOutput);
						result.savedAs = outputName;
					}
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);
				const invocations = params.tasks.map((t, index) => resolveInvocation({
					agents,
					spec: { ...t, saveAs: t.saveAs || (params.tasks!.length > 1 ? `${t.agent}-${index + 1}` : t.agent) },
					teamName,
					modelResolution: modelResolutionFor(t.agent),
				}));
				preflightValidateInvocations(invocations, catalogPort, ctx.cwd);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: invocations[i].agentName,
						agentSource: invocations[i].agent.source,
						task: invocations[i].display,
						promptKind: invocations[i].promptKind,
						input: invocations[i].input,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						...buildResolvedModelMetadata(invocations[i].resolvedModel),
						startTime: Date.now(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(invocations, MAX_PARALLEL_AGENTS, async (invocation, index) => {
					const outputName = invocation.saveAs || invocation.agentName;

					try {
						const result = await runSingleAgent(
							ctx.cwd, invocation, signal,
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
						);

						// Team mode: save named output
						if (teamName && isSuccessfulResult(result)) {
							const output = getFinalOutput(result.messages);
							if (output) {
								saveOutput(teamName, outputName, output);
								result.savedAs = outputName;
							}
						}

						allResults[index] = result;
						emitParallelUpdate();
						return result;
					} catch (err) {
						// A single failed task must not discard the whole batch:
						// synthesize a FAILED RESULT mirroring the placeholder shape.
						const failed: SingleResult = {
							...allResults[index],
							exitCode: 1,
							stderr: err instanceof Error ? err.message : String(err),
						};
						allResults[index] = failed;
						emitParallelUpdate();
						return failed;
					}
				});

				const successCount = results.filter((r) => isSuccessfulResult(r)).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const failed = !isSuccessfulResult(r);
					const fallback = failed ? (r.stderr ?? "").slice(0, 200) : "";
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${isSuccessfulResult(r) ? "completed" : "failed"}: ${preview || fallback || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && (params.task !== undefined || params.input !== undefined)) {
				const outputName = params.saveAs || params.agent;
				const invocation = resolveInvocation({
					agents,
					spec: {
						agent: params.agent,
						task: params.task,
						input: params.input,
						cwd: params.cwd,
						saveAs: outputName,
						mcps: params.mcps,
						extensions: params.extensions,
					},
					teamName,
					modelResolution: modelResolutionFor(params.agent),
				});
				preflightValidateInvocations([invocation], catalogPort, ctx.cwd);

				// ── Background mode ──
				if (params.background) {
					const jobId = generateBgId(invocation.agentName, invocation.saveAs);

					// Check concurrency
					const runningCount = [...backgroundAgents.values()].filter(
						(a) => a.status === "running" || a.status === "waiting",
					).length;

					const bgAgent: BackgroundAgent = {
						id: jobId,
						agent: invocation.agentName,
						task: invocation.display,
						prompt: invocation.prompt,
						promptKind: invocation.promptKind,
						input: invocation.input,
						result: {
							agent: invocation.agentName,
							agentSource: invocation.agent.source,
							task: invocation.display,
							promptKind: invocation.promptKind,
							input: invocation.input,
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							...buildResolvedModelMetadata(invocation.resolvedModel),
							startTime: Date.now(),
						},
						status: runningCount >= MAX_PARALLEL_AGENTS ? "queued" : "running",
						startTime: Date.now(),
						cwd: invocation.cwd ?? ctx.cwd,
						resolvedModel: invocation.resolvedModel,
						agentConfig: invocation.agent,
						teamName,
						saveAs: invocation.saveAs,
						extensions: invocation.extensions,
						mcps: invocation.mcps,
					};

					backgroundAgents.set(jobId, bgAgent);
					evictCompletedAgents();

					if (bgAgent.status === "running") {
						launchBackgroundAgent(bgAgent);
					} else {
						const queuePos = [...backgroundAgents.values()].filter((a) => a.status === "queued").length;
						piRef?.sendMessage(
							{
								customType: "subagent-bg",
								content: `[⏳ QUEUED ${jobId}] Position ${queuePos} — waiting for a slot`,
								display: true,
							},
							{ triggerTurn: false },
						);
						updateBgWidget();
					}

					return {
						content: [
							{
								type: "text",
								text:
									bgAgent.status === "queued"
										? `Background agent queued: ${jobId} (${bgAgent.agent})\nStatus: queued — ${runningCount}/${MAX_PARALLEL_AGENTS} slots in use\nUse subagent_status(id: "${jobId}") to check progress.`
										: `Background agent started: ${jobId} (${bgAgent.agent})\nStatus: running\nUse subagent_status(id: "${jobId}") to check progress.`,
							},
						],
						details: makeDetails("single")([bgAgent.result]),
					};
				}

				const result = await runSingleAgent(
					ctx.cwd, invocation, signal, onUpdate, makeDetails("single"),
				);

				// Team mode: save named output
				if (teamName && isSuccessfulResult(result)) {
					const output = getFinalOutput(result.messages);
					if (output) {
						saveOutput(teamName, outputName, output);
						result.savedAs = outputName;
					}
				}

				const isError = !isSuccessfulResult(result);

				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const displayTask = step.task ? step.task.replace(/\{previous\}/g, "").trim() : displayInputSummary(step.input);
					const preview = displayTask.length > 40 ? `${displayTask.slice(0, 40)}...` : displayTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const displayTask = t.task ? t.task : displayInputSummary(t.input);
					const preview = displayTask.length > 40 ? `${displayTask.slice(0, 40)}...` : displayTask;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const displayTask = args.task ? args.task : args.input !== undefined ? displayInputSummary(args.input) : "...";
			const preview = displayTask.length > 60 ? `${displayTask.slice(0, 60)}...` : displayTask;
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
				const isBackground = resultText.startsWith("Background agent started") || resultText.startsWith("Background agent queued");
				const isRunning = !isBackground && r.exitCode === -1;
				const isError = !isBackground && !isRunning && (!isSuccessfulResult(r));
				const icon = isBackground ? "🏃" : isRunning ? theme.fg("warning", "⏳") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (details.team) header += theme.fg("dim", ` [team:${details.team}]`);
					if (r.savedAs) header += theme.fg("accent", ` → ${r.savedAs}`);
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", r.promptKind === "input" ? "─── Input ───" : "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					const transcript = buildTranscript(r.task, r.messages, 2000);
					if (transcript.length === 0) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const entry of transcript) {
							if (entry.kind === "prompt") {
								container.addChild(new Text(theme.fg("muted", "▸ prompt"), 0, 0));
								for (const line of entry.text.split("\n"))
									container.addChild(new Text(theme.fg("dim", line), 0, 0));
							} else if (entry.kind === "assistant") {
								container.addChild(new Markdown(entry.text.trim(), 0, 0, mdTheme));
							} else if (entry.kind === "tool") {
								container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("toolOutput", entry.text), 0, 0));
							} else if (entry.kind === "result") {
								for (const line of entry.text.split("\n"))
									container.addChild(new Text(theme.fg("dim", "  ⤷ " + line), 0, 0));
							}
							container.addChild(new Spacer(1));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model ?? r.resolvedModel, {
						provider: r.provider,
						contextWindow: r.contextWindow,
						elapsedMs: Date.now() - r.startTime,
						thinkingLevel: r.resolvedThinkingLevel,
						source: r.configSource,
					});
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (details.team) text += theme.fg("dim", ` [team:${details.team}]`);
				if (r.savedAs) text += theme.fg("accent", ` → ${r.savedAs}`);
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model ?? r.resolvedModel, {
					provider: r.provider,
					contextWindow: r.contextWindow,
					elapsedMs: Date.now() - r.startTime,
					thinkingLevel: r.resolvedThinkingLevel,
					source: r.configSource,
				});
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			const aggregateElapsedMs = (results: SingleResult[]) => {
				const earliest = Math.min(...results.map((r) => r.startTime));
				return Date.now() - earliest;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => isSuccessfulResult(r)).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isSuccessfulResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						const label = r.promptKind === "input" ? "Input: " : "Task: ";
						container.addChild(new Text(theme.fg("muted", label) + theme.fg("dim", r.task), 0, 0));

						const transcript = buildTranscript(r.task, r.messages, 2000);
						if (transcript.length === 0) {
							container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
						} else {
							for (const entry of transcript) {
								if (entry.kind === "prompt") {
									container.addChild(new Text(theme.fg("muted", "▸ prompt"), 0, 0));
									for (const line of entry.text.split("\n"))
										container.addChild(new Text(theme.fg("dim", line), 0, 0));
								} else if (entry.kind === "assistant") {
									container.addChild(new Markdown(entry.text.trim(), 0, 0, mdTheme));
								} else if (entry.kind === "tool") {
									container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("toolOutput", entry.text), 0, 0));
								} else if (entry.kind === "result") {
									for (const line of entry.text.split("\n"))
										container.addChild(new Text(theme.fg("dim", "  ⤷ " + line), 0, 0));
								}
								container.addChild(new Spacer(1));
							}
						}

						const stepUsage = formatUsageStats(r.usage, r.model ?? r.resolvedModel, {
							provider: r.provider,
							contextWindow: r.contextWindow,
							elapsedMs: Date.now() - r.startTime,
							thinkingLevel: r.resolvedThinkingLevel,
							source: r.configSource,
						});
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results), undefined, {
						elapsedMs: aggregateElapsedMs(details.results),
					});
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isSuccessfulResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results), undefined, {
					elapsedMs: aggregateElapsedMs(details.results),
				});
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => isSuccessfulResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && !isSuccessfulResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isSuccessfulResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						const label = r.promptKind === "input" ? "Input: " : "Task: ";
						container.addChild(new Text(theme.fg("muted", label) + theme.fg("dim", r.task), 0, 0));

						const transcript = buildTranscript(r.task, r.messages, 2000);
						if (transcript.length === 0) {
							container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
						} else {
							for (const entry of transcript) {
								if (entry.kind === "prompt") {
									container.addChild(new Text(theme.fg("muted", "▸ prompt"), 0, 0));
									for (const line of entry.text.split("\n"))
										container.addChild(new Text(theme.fg("dim", line), 0, 0));
								} else if (entry.kind === "assistant") {
									container.addChild(new Markdown(entry.text.trim(), 0, 0, mdTheme));
								} else if (entry.kind === "tool") {
									container.addChild(new Text(theme.fg("muted", "→ ") + theme.fg("toolOutput", entry.text), 0, 0));
								} else if (entry.kind === "result") {
									for (const line of entry.text.split("\n"))
										container.addChild(new Text(theme.fg("dim", "  ⤷ " + line), 0, 0));
								}
								container.addChild(new Spacer(1));
							}
						}

						const taskUsage = formatUsageStats(r.usage, r.model ?? r.resolvedModel, {
							provider: r.provider,
							contextWindow: r.contextWindow,
							elapsedMs: Date.now() - r.startTime,
							thinkingLevel: r.resolvedThinkingLevel,
							source: r.configSource,
						});
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results), undefined, {
						elapsedMs: aggregateElapsedMs(details.results),
					});
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isSuccessfulResult(r)
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results), undefined, {
						elapsedMs: aggregateElapsedMs(details.results),
					});
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_steer",
		label: "Steer Background Agent",
		description: "Send a message to a running/waiting background agent.",
		parameters: Type.Object({
			id: Type.String({ description: "Background agent job ID" }),
			message: Type.String({ description: "Message to send to the agent" }),
			interrupt: Type.Optional(
				Type.Boolean({ description: "Abort current turn before sending (default: false)", default: false }),
			),
		}),
		async execute(_toolCallId, params) {
			// V2: Group resolution
			const resolved = resolveId(params.id);
			if (resolved.type === "group") {
				const group = resolved.group;
				if (group.mode === "parallel") {
					const memberList = group.memberIds.join(", ");
					return {
						content: [{ type: "text", text: `Cannot steer a parallel group directly. Specify a member: ${memberList}` }],
						details: undefined,
						isError: true,
					};
				}
				if (group.currentStepIndex !== undefined) {
					const activeId = group.memberIds[group.memberIds.length - 1];
					const activeAgent = backgroundAgents.get(activeId);
					if (activeAgent && (activeAgent.status === "running" || activeAgent.status === "waiting")) {
						params.id = activeId;
					} else {
						return {
							content: [{ type: "text", text: `Chain "${group.groupId}" has no active running step to steer.` }],
							details: undefined,
							isError: true,
						};
					}
				}
			}

			const bgAgent = backgroundAgents.get(params.id);
			if (!bgAgent) {
				return {
					content: [{ type: "text", text: `No background agent found with id "${params.id}"` }],
					details: undefined,
					isError: true,
				};
			}
			if (bgAgent.status !== "running" && bgAgent.status !== "waiting") {
				return {
					content: [{ type: "text", text: `Agent "${params.id}" is ${bgAgent.status}, cannot steer.` }],
					details: undefined,
					isError: true,
				};
			}
			const child = bgAgent.sdk ?? await bgAgent.sdkReady;
			if (!child || (bgAgent.status !== "running" && bgAgent.status !== "waiting") || bgAgent.sdkCleanupStarted) {
				throw new Error(`Agent "${params.id}" is no longer running`);
			}
			if (params.interrupt) {
				bgAgent.sdkRunId = (bgAgent.sdkRunId ?? 0) + 1;
				bgAgent.interrupting = true;
				try {
					await child.abort();
					child.takeSignal();
				} finally { bgAgent.interrupting = false; }
			}
			if ((bgAgent.status !== "running" && bgAgent.status !== "waiting") || bgAgent.sdkCleanupStarted) {
				return { content: [{ type: "text", text: `Agent "${params.id}" was stopped before steering completed.` }], details: undefined };
			}
			if (bgAgent.status === "waiting" || params.interrupt) {
				bgAgent.status = "running";
				updateBgWidget();
				void runSdkBackgroundPrompt(bgAgent, params.message);
			} else {
				await child.steer(params.message);
			}
			return {
				content: [{ type: "text", text: `Steered "${params.id}": ${params.interrupt ? "(interrupted) " : ""}${params.message.slice(0, 100)}` }],
				details: undefined,
			};
		},
		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Background Agent Status",
		description: "Check status of background agents. Omit id for all agents.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Specific job ID, or omit for all" })),
		}),
		async execute(_toolCallId, params) {
			if (params.id) {
				// V2: Check if it's a group ID first
				const resolved = resolveId(params.id);
				if (resolved.type === "group") {
					const group = resolved.group;
					const members = group.memberIds.map((id) => backgroundAgents.get(id)).filter(Boolean) as BackgroundAgent[];
					const elapsed = formatDuration((group.endTime ?? Date.now()) - group.startTime);

					let statusLine: string;
					if (group.mode === "parallel") {
						const done = members.filter((m) => m.status === "done" || m.status === "error" || m.status === "aborted").length;
						statusLine = `Status: ${group.status} (${done}/${members.length} done)`;
					} else {
						statusLine = `Status: ${group.status} — step ${(group.currentStepIndex ?? 0) + 1}/${group.chainSteps?.length ?? 0}`;
					}

					const memberLines = members.map((m) => {
						const mElapsed = formatDuration((m.endTime ?? Date.now()) - m.startTime);
						const icon = m.status === "done" ? "✅" : m.status === "error" ? "❌" : m.status === "running" ? "⏳" : m.status === "queued" ? "📋" : m.status === "aborted" ? "🛑" : "⏸️";
						return `  ${icon} ${m.id} — ${m.status} (${mElapsed}, ${m.result.usage.turns} turns)`;
					});

					if (group.mode === "chain" && group.chainSteps) {
						const startedCount = group.memberIds.length;
						for (let i = startedCount; i < group.chainSteps.length; i++) {
							memberLines.push(`  ⏸️ step ${i + 1}: ${group.chainSteps[i].agent} — pending`);
						}
					}

					return {
						content: [{
							type: "text",
							text: [
								`Group: ${group.groupId} (${group.mode}, ${group.mode === "chain" ? `${group.chainSteps?.length ?? 0} steps` : `${members.length} tasks`})`,
								statusLine,
								`Elapsed: ${elapsed}`,
								group.mode === "parallel" ? "Members:" : "Steps:",
								...memberLines,
							].join("\n"),
						}],
						details: { mode: "single" as const, results: members.map((m) => m.result) },
					};
				}

				const bgAgent = backgroundAgents.get(params.id);
				if (!bgAgent) {
					return {
						content: [{ type: "text", text: `No background agent found with id "${params.id}"` }],
						details: {
							mode: "single" as const,
							results: [],
						},
						isError: true,
					};
				}
				const elapsedMs = (bgAgent.endTime ?? Date.now()) - bgAgent.startTime;
				const elapsed = formatDuration(elapsedMs);
				const turns = bgAgent.result.usage.turns;
				const lastTools = bgAgent.result.messages
					.filter((m) => m.role === "assistant")
					.flatMap((m) => m.content.filter((p: any) => p.type === "toolCall").map((p: any) => p.name))
					.slice(-5);
				const usageStr = formatUsageStats(bgAgent.result.usage, bgAgent.result.model ?? bgAgent.result.resolvedModel, {
					provider: bgAgent.result.provider,
					contextWindow: bgAgent.result.contextWindow,
					elapsedMs,
					thinkingLevel: bgAgent.result.resolvedThinkingLevel,
					source: bgAgent.result.configSource,
				});

				return {
					content: [
						{
							type: "text",
							text: [
								`Agent: ${bgAgent.id} (${bgAgent.agent})`,
								`Status: ${bgAgent.status}`,
								`Elapsed: ${elapsed}`,
								`Turns: ${turns}`,
								lastTools.length > 0 ? `Recent tools: ${lastTools.join(", ")}` : null,
								usageStr ? `Usage: ${usageStr}` : null,
								`${bgAgent.promptKind === "input" ? "Input" : "Task"}: ${bgAgent.task.slice(0, 150)}`,
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: {
						mode: "single" as const,
						results: [bgAgent.result],
					},
				};
			}

			const entries = [...backgroundAgents.values()];
			const groupEntries = [...backgroundGroups.values()].filter(
				(g) => g.status === "running" || g.status === "error" || g.status === "done" || g.status === "aborted",
			);
			const soloEntries = entries.filter((a) => !a.groupId);

			if (groupEntries.length === 0 && soloEntries.length === 0) {
				return {
					content: [{ type: "text", text: "No background agents." }],
					details: {
						mode: "single" as const,
						results: [],
					},
				};
			}

			const queuedEntries = soloEntries.filter((a) => a.status === "queued");
			const queuePositions = new Map(queuedEntries.map((a, index) => [a.id, index + 1]));
			const groupLines = groupEntries.map((g) => {
				const elapsed = formatDuration((g.endTime ?? Date.now()) - g.startTime);
				if (g.mode === "parallel") {
					const members = g.memberIds.map((id) => backgroundAgents.get(id)).filter(Boolean) as BackgroundAgent[];
					const done = members.filter((m) => m.status === "done" || m.status === "error" || m.status === "aborted").length;
					const icon = g.status === "done" ? "✅" : g.status === "error" ? "❌" : g.status === "aborted" ? "🛑" : "🔀";
					return `${icon} ${g.groupId} (parallel) — ${done}/${members.length} done — ${elapsed}`;
				}
				const icon = g.status === "done" ? "✅" : g.status === "error" ? "❌" : g.status === "aborted" ? "🛑" : "🔗";
				return `${icon} ${g.groupId} (chain) — step ${(g.currentStepIndex ?? 0) + 1}/${g.chainSteps?.length ?? 0} — ${elapsed}`;
			});
			const soloLines = soloEntries.map((a) => {
				const elapsed = formatDuration((a.endTime ?? Date.now()) - a.startTime);
				const icon =
					a.status === "running" ? "⏳" :
					a.status === "waiting" ? "❓" :
					a.status === "queued" ? "📋" :
					a.status === "done" ? "✅" :
					a.status === "error" ? "❌" :
					"🛑";
				const queueInfo = a.status === "queued" ? ` (position ${queuePositions.get(a.id)})` : "";
				return `${icon} ${a.id} (${a.agent}) — ${a.status}${queueInfo} — ${elapsed} — ${a.result.usage.turns} turns`;
			});
			const lines = [...groupLines, ...soloLines];
			const running = entries.filter((a) => a.status === "running" || a.status === "waiting").length;
			const queued = entries.filter((a) => a.status === "queued").length;

			return {
				content: [
					{
						type: "text",
						text: `Background agents (${groupEntries.length} groups, ${soloEntries.length} solo, ${running} running, ${queued} queued):\n${lines.join("\n")}`,
					},
				],
				details: {
					mode: "single" as const,
					results: [...groupEntries.flatMap((g) => g.memberIds.map((id) => backgroundAgents.get(id)).filter(Boolean) as BackgroundAgent[]), ...soloEntries].map((a) => a.result),
				},
			};
		},
		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Stop Background Agent",
		description: "Kill a running background agent or cancel a queued one.",
		parameters: Type.Object({
			id: Type.String({ description: "Background agent job ID" }),
		}),
		async execute(_toolCallId, params) {
			// V2: Group resolution
			const resolved = resolveId(params.id);
			if (resolved.type === "group") {
				const group = resolved.group;
				if (group.status === "done" || group.status === "error" || group.status === "aborted") {
					return {
						content: [{ type: "text", text: `Group "${group.groupId}" already ${group.status}.` }],
						details: {
							mode: "single" as const,
							results: (group.memberIds.map((id) => backgroundAgents.get(id)).filter(Boolean) as BackgroundAgent[]).map((m) => m.result),
						},
					};
				}
				group.status = "aborted";
				group.endTime = Date.now();

				let stoppedCount = 0;
				for (const mid of group.memberIds) {
					const m = backgroundAgents.get(mid);
					if (m && (m.status === "running" || m.status === "waiting")) {
						m.status = "aborted";
						m.endTime = Date.now();
						killBgProcess(m);
						stoppedCount++;
					} else if (m && m.status === "queued") {
						m.status = "aborted";
						m.endTime = Date.now();
						stoppedCount++;
					}
				}

				piRef?.sendMessage(
					{ customType: "subagent-bg", content: `[🛑 ABORTED ${group.groupId}]`, display: true },
					{ triggerTurn: false },
				);

				updateBgWidget();
				trySpawnQueued();

				return {
					content: [{ type: "text", text: `Stopped group "${group.groupId}". ${stoppedCount} members aborted.` }],
					details: {
						mode: "single" as const,
						results: (group.memberIds.map((id) => backgroundAgents.get(id)).filter(Boolean) as BackgroundAgent[]).map((m) => m.result),
					},
				};
			}

			const bgAgent = backgroundAgents.get(params.id);
			if (!bgAgent) {
				return {
					content: [{ type: "text", text: `No background agent found with id "${params.id}"` }],
					details: {
						mode: "single" as const,
						results: [],
					},
					isError: true,
				};
			}

			if (bgAgent.status === "done" || bgAgent.status === "error" || bgAgent.status === "aborted") {
				return {
					content: [{ type: "text", text: `Agent "${params.id}" already ${bgAgent.status}.` }],
					details: {
						mode: "single" as const,
						results: [bgAgent.result],
					},
				};
			}

			const wasQueued = bgAgent.status === "queued";
			bgAgent.status = "aborted";
			bgAgent.endTime = Date.now();

			if (!wasQueued) {
				killBgProcess(bgAgent);
			}

			if (bgAgent.teamName && bgAgent.saveAs) {
				const output = getFinalOutput(bgAgent.result.messages);
				if (output) {
					try { saveOutput(bgAgent.teamName, bgAgent.saveAs, output); } catch { /* ignore */ }
					bgAgent.result.savedAs = bgAgent.saveAs;
				}
			}

			piRef?.sendMessage(
				{
					customType: "subagent-bg",
					content: `[🛑 ABORTED ${bgAgent.id}]`,
					display: true,
				},
				{ triggerTurn: false },
			);

			if (bgAgent.groupId) {
				const group = backgroundGroups.get(bgAgent.groupId);
				if (group) {
					if (group.mode === "chain") {
						group.status = "aborted";
						group.endTime = Date.now();
						for (const mid of group.memberIds) {
							const member = backgroundAgents.get(mid);
							if (member && member.id !== bgAgent.id && (member.status === "running" || member.status === "waiting" || member.status === "queued")) {
								const memberWasQueued = member.status === "queued";
								member.status = "aborted";
								member.endTime = Date.now();
								if (!memberWasQueued) killBgProcess(member);
							}
						}
						piRef?.sendMessage(
							{ customType: "subagent-bg", content: `[🛑 ABORTED ${group.groupId}]`, display: true },
							{ triggerTurn: false },
						);
					} else {
						checkParallelGroupCompletion(group);
					}
				}
			}

			updateBgWidget();
			trySpawnQueued();

			return {
				content: [
					{
						type: "text",
						text: `Stopped "${params.id}". ${bgAgent.result.usage.turns} turns completed before abort.`,
					},
				],
				details: {
					mode: "single" as const,
					results: [bgAgent.result],
				},
			};
		},
		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// ── Session cleanup ──────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		await shutdownAllBackgroundAgents();
		uiSetWidget = null;
	});

	// ── Agent management commands ───────────────────────────────────

	pi.registerCommand("agents", {
		description: "List currently running agents (foreground and background) with their ids.",
		handler: async (_args, ctx) => {
			// Overlay width is fixed at creation, so to switch between the narrow
			// list and the wider two-pane expanded view we mirror pier: close the
			// overlay and reopen it at the new width, preserving the selection.
			let mode: "list" | "expanded" = "list";
			let selected = 0;
			let open = true;
			while (open) {
				const nextMode: "list" | "expanded" | null = await ctx.ui.custom<"list" | "expanded" | null>(
					(tui, theme, _keybindings, done) => {
						let panel: AgentsPanel;
						panel = new AgentsPanel({
							theme,
							mode,
							initialSelectedIndex: selected,
							getAgents: () => {
							const agents: PanelAgent[] = [];
							for (const h of listForegroundAgents()) {
								agents.push({
									id: h.id,
									origin: "foreground",
									agentName: h.agentName,
									task: h.task,
									startTime: h.startTime,
									lastEventAt: h.lastEventAt,
									currentTool: h.currentTool,
									status: "running",
									output: h.result ? getFinalOutput(h.result.messages) : "",
									transcript: h.result ? buildTranscript(h.task, h.result.messages) : [{ kind: "prompt", text: h.task }],
								});
							}
							for (const a of backgroundAgents.values()) {
								if (a.status !== "running" && a.status !== "queued" && a.status !== "waiting") continue;
								agents.push({
									id: a.id,
									origin: "background",
									agentName: a.agent,
									task: a.task,
									startTime: a.startTime,
									status: a.status,
									lastEventAt: a.lastEventAt,
									currentTool: a.currentTool,
									output: getFinalOutput(a.result.messages),
									transcript: buildTranscript(a.task, a.result.messages),
								});
							}
							return agents;
						},
						onKill: (id) => {
							if (killForegroundAgent(id)) return true;
							const bgAgent = backgroundAgents.get(id);
							if (bgAgent && (bgAgent.status === "running" || bgAgent.status === "queued" || bgAgent.status === "waiting")) {
								const wasQueued = bgAgent.status === "queued";
								bgAgent.status = "aborted";
								bgAgent.endTime = Date.now();
								if (!wasQueued) {
									killBgProcess(bgAgent);
								}
								updateBgWidget();
								trySpawnQueued();
								return true;
							}
							return false;
						},
							onExpand: () => { selected = panel.selected; done("expanded"); },
							onCollapse: () => { selected = panel.selected; done("list"); },
							onClose: () => { selected = panel.selected; done(null); },
							requestRender: () => tui.requestRender(),
							getHeight: () => {
								const rows = (tui as { rows?: number }).rows;
								if (typeof rows === "number" && rows > 0) return rows;
								const termRows = (tui as { terminal?: { rows?: number } }).terminal?.rows;
								return typeof termRows === "number" && termRows > 0 ? termRows : 30;
							},
						});
						return panel;
					},
					{
						overlay: true,
						overlayOptions: () => ({
							anchor: "top-right" as const,
							width: mode === "expanded" ? "60%" : "32%",
							minWidth: mode === "expanded" ? 70 : 34,
							maxHeight: "100%",
							margin: { right: 0, top: 0 },
						}),
					},
				);
				if (nextMode === null || nextMode === undefined) open = false;
				else mode = nextMode;
			}
		},
	});

	pi.registerCommand("kill-agent", {
		description: "Kill one running agent by id without affecting the others. Usage: /kill-agent <id>",
		handler: async (args, ctx) => {
			const id = (args || "").trim();
			if (!id) {
				ctx.ui.notify("Usage: /kill-agent <id>  (run /agents to see ids)", "warning");
				return;
			}

			if (killForegroundAgent(id)) {
				ctx.ui.notify(`Killed foreground agent ${id}.`, "info");
				return;
			}

			const bgAgent = backgroundAgents.get(id);
			if (bgAgent && (bgAgent.status === "running" || bgAgent.status === "queued" || bgAgent.status === "waiting")) {
				const wasQueued = bgAgent.status === "queued";
				bgAgent.status = "aborted";
				bgAgent.endTime = Date.now();
				if (!wasQueued) {
					killBgProcess(bgAgent);
				}
				updateBgWidget();
				trySpawnQueued();
				ctx.ui.notify(`Killed background agent ${id}.`, "info");
				return;
			}

			ctx.ui.notify(`No running agent with id "${id}". Run /agents to see ids.`, "warning");
		},
	});

	// ── Team commands ────────────────────────────────────────────────

	pi.registerCommand("team", {
		description: "List teams, show info, create, or delete. Usage: /team [info|new|delete|outputs] [name]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const subcommand = parts[0] || "list";
			const teamArg = parts.slice(1).join(" ");

			if (subcommand === "list" || subcommand === "") {
				const teams = listTeams();
				if (teams.length === 0) {
					ctx.ui.notify(`No teams found.\nCreate one: /team new <name>\nTeams dir: ${getTeamsDir()}`, "info");
					return;
				}
				const lines = teams.map((t) => {
					const outputs = t.outputs.length > 0 ? t.outputs.join(", ") : "none";
					const ctx_flag = t.hasSharedContext ? "✓" : "✗";
					return `  ${t.name}  context:${ctx_flag}  outputs:[${outputs}]  created:${t.created.slice(0, 10)}`;
				});
				ctx.ui.notify(`Teams:\n${lines.join("\n")}`, "info");
				return;
			}

			if (subcommand === "new" || subcommand === "create") {
				if (!teamArg) {
					ctx.ui.notify("Usage: /team new <name>", "warning");
					return;
				}
				const dir = ensureTeamDir(teamArg);
				ctx.ui.notify(
					`Team "${teamArg}" created.\n` +
						`  Dir: ${dir}\n` +
						`  Write shared context to: ${dir}/shared_context.md\n` +
						`  Outputs will be saved to: ${dir}/outputs/`,
					"info",
				);
				return;
			}

			if (subcommand === "info") {
				if (!teamArg) {
					ctx.ui.notify("Usage: /team info <name>", "warning");
					return;
				}
				if (!teamExists(teamArg)) {
					ctx.ui.notify(`Team "${teamArg}" not found.`, "error");
					return;
				}
				const dir = getTeamDir(teamArg);
				const outputs = listOutputs(teamArg);
				const sharedCtx = loadSharedContext(teamArg);
				const ctxPreview = sharedCtx
					? sharedCtx.slice(0, 200) + (sharedCtx.length > 200 ? "..." : "")
					: "(empty)";
				const outputList =
					outputs.length > 0 ? outputs.map((o) => `  - ${o}`).join("\n") : "  (none)";

				ctx.ui.notify(
					`Team: ${teamArg}\n` +
						`Dir: ${dir}\n\n` +
						`Shared Context:\n${ctxPreview}\n\n` +
						`Outputs:\n${outputList}`,
					"info",
				);
				return;
			}

			if (subcommand === "outputs") {
				if (!teamArg) {
					ctx.ui.notify("Usage: /team outputs <name>", "warning");
					return;
				}
				if (!teamExists(teamArg)) {
					ctx.ui.notify(`Team "${teamArg}" not found.`, "error");
					return;
				}
				const outputs = listOutputs(teamArg);
				if (outputs.length === 0) {
					ctx.ui.notify(`Team "${teamArg}" has no outputs yet.`, "info");
					return;
				}
				const dir = getTeamDir(teamArg);
				const lines = outputs.map((o) => `  ${o} → ${dir}/outputs/${o}.md`);
				ctx.ui.notify(`Outputs for ${teamArg}:\n${lines.join("\n")}`, "info");
				return;
			}

			if (subcommand === "delete" || subcommand === "rm") {
				if (!teamArg) {
					ctx.ui.notify("Usage: /team delete <name>", "warning");
					return;
				}
				if (!teamExists(teamArg)) {
					ctx.ui.notify(`Team "${teamArg}" not found.`, "error");
					return;
				}
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm("Delete team?", `Delete "${teamArg}" and all its outputs?`);
					if (!ok) {
						ctx.ui.notify("Cancelled.", "info");
						return;
					}
				}
				deleteTeam(teamArg);
				ctx.ui.notify(`Team "${teamArg}" deleted.`, "info");
				return;
			}

			ctx.ui.notify(
				"Unknown subcommand. Usage:\n" +
					"  /team              — list all teams\n" +
					"  /team new <name>   — create a team\n" +
					"  /team info <name>  — show team details\n" +
					"  /team outputs <name> — list saved outputs\n" +
					"  /team delete <name> — delete a team",
				"warning",
			);
		},
	});
}
