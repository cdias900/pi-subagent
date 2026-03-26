/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { registerCoordinationTools } from "./coordination.js";
import {
	buildTeamTask,
	deleteTeam,
	ensureTeamDir,
	getTeamDir,
	getTeamsDir,
	listOutputs,
	listTeams,
	loadSharedContext,
	removeScopedMcpConfig,
	saveOutput,
	teamExists,
	writeScopedMcpConfig,
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
			} else if (entry.isDirectory()) {
				const idx = path.join(globalExtDir, entry.name, "index.ts");
				if (fs.existsSync(idx)) {
					extMap.set(entry.name, idx);
				}
			}
		}
	}

	// 2. Installed git packages — scan extensions/ subdirectories
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
		if (extPath) resolved.push(extPath);
	}
	return resolved;
}

/**
 * Find the mcp-bridge extension's index.ts — checks installed packages (git/) and extensions dir.
 */
function findMcpBridgePath(agentDir: string): string | null {
	const candidates = [
		// Installed via pi install (git package)
		path.join(agentDir, "git", "github.com", "cdias900", "pi-mcp-bridge", "index.ts"),
		// Local extension (auto-discovered)
		path.join(agentDir, "extensions", "mcp-bridge", "index.ts"),
	];

	// Also check for any pi-mcp-bridge package in the git dir (different usernames)
	try {
		const gitDir = path.join(agentDir, "git", "github.com");
		if (fs.existsSync(gitDir)) {
			for (const user of fs.readdirSync(gitDir)) {
				const candidate = path.join(gitDir, user, "pi-mcp-bridge", "index.ts");
				if (!candidates.includes(candidate)) candidates.push(candidate);
			}
		}
	} catch {
		/* ignore */
	}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}

	return null;
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_BG_CONCURRENCY = 8;
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

/**
 * Parse a model string like "openai/gpt-5.4:xhigh" or "anthropic-1m/claude-opus-4-6:high"
 * into { provider, model, reasoning }.
 */
function parseModelString(modelStr: string): { provider: string; model: string; reasoning: string } {
	let provider = "—";
	let model = modelStr;
	let reasoning = "off";

	// Extract reasoning level from suffix ":level"
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx > 0) {
		const suffix = model.slice(colonIdx + 1);
		if (["minimal", "low", "medium", "high", "xhigh"].includes(suffix)) {
			reasoning = suffix;
			model = model.slice(0, colonIdx);
		}
	}

	// Extract provider from prefix "provider/"
	const slashIdx = model.indexOf("/");
	if (slashIdx > 0) {
		provider = model.slice(0, slashIdx);
		model = model.slice(slashIdx + 1);
	}

	return { provider, model, reasoning };
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

function formatUsageStats(
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
	},
): string {
	const sep = " │ ";
	const hasSingleAgentData = !!model;

	if (hasSingleAgentData) {
		// Two-line format for single agent results
		// Line 1: tokens │ cost │ context %
		const line1Parts: string[] = [];
		const totalTokens = (usage.input || 0) + (usage.output || 0);
		if (totalTokens > 0) line1Parts.push(`${formatTokens(totalTokens)} tokens`);
		if (usage.cost) line1Parts.push(`$${usage.cost.toFixed(3)}`);
		if (usage.contextTokens && usage.contextTokens > 0) {
			const parsed = parseModelString(model);
			const ctxWindow = getContextWindow(parsed.model);
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
		const parsed = parseModelString(model);
		const provider = opts?.provider || parsed.provider;
		line2Parts.push(`${provider} ● ${parsed.model} ● ${parsed.reasoning}`);
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
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	savedAs?: string;
	startTime: number;
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
	proc: ChildProcess | null;
	result: SingleResult;
	status: "queued" | "running" | "waiting" | "done" | "error" | "aborted";
	startTime: number;
	endTime?: number;
	cwd: string;
	agentConfig: AgentConfig;
	spawnArgs: string[];
	spawnEnv?: Record<string, string | undefined>;
	tmpPromptDir?: string;
	tmpPromptPath?: string;
	mcpCleanupName?: string;
	teamName?: string;
	saveAs?: string;
	extensions?: string[];
	mcps?: string[];
}

const backgroundAgents = new Map<string, BackgroundAgent>();
const bgAutoCounter = new Map<string, number>();
let piRef: ExtensionAPI | null = null;

// UI context captured on session_start — used for belowEditor widget updates
let uiSetWidget: ((key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void) | null = null;

/** Path to the bg-signal extension that registers __bg_signal as a real tool in child processes */
const BG_SIGNAL_EXT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "bg-signal.ts");

/**
 * Update the belowEditor widget showing active background agents.
 * Called after every status transition. Removes widget when no agents are active.
 */
function updateBgWidget(): void {
	if (!uiSetWidget) return;

	const active = [...backgroundAgents.values()].filter(
		(a) => a.status === "running" || a.status === "queued" || a.status === "waiting",
	);

	if (active.length === 0) {
		uiSetWidget("subagent-bg", undefined);
		return;
	}

	const lines = active.map((a) => {
		const elapsed = formatDuration((a.endTime ?? Date.now()) - a.startTime);
		const icon =
			a.status === "running" ? "🏃" :
			a.status === "waiting" ? "⏸️" :
			"📋";
		const taskPreview = a.task.length > 50 ? `${a.task.slice(0, 50)}…` : a.task;
		return `${icon} ${a.id} — ${a.status} ${elapsed}  ${taskPreview}`;
	});

	uiSetWidget("subagent-bg", [`🤖 Background agents (${active.length})`, ...lines], { placement: "belowEditor" });
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

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	mcps?: string[],
	runtimeExtensions?: string[],
	teamName?: string,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			startTime: Date.now(),
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];

	// Merge extensions from agent frontmatter and runtime (orchestrator) request, deduplicate
	const agentDir = getAgentDir();
	const allExtensions = new Set<string>([
		...(agent.extensions || []),
		...(runtimeExtensions || []),
	]);
	if (allExtensions.size > 0) {
		const extensionPaths = resolveExtensionPaths(agentDir, [...allExtensions]);
		for (const extPath of extensionPaths) {
			args.push("-e", extPath);
		}
	}

	// If MCPs are requested, write a scoped config and load only the mcp-bridge extension
	let mcpConfigPath: string | null = null;
	let mcpCleanupName: string | null = null;
	if (mcps && mcps.length > 0 && teamName) {
		const saveAs = `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		mcpConfigPath = writeScopedMcpConfig(teamName, saveAs, mcps);
		mcpCleanupName = saveAs;
		if (mcpConfigPath) {
			const bridgePath = findMcpBridgePath(agentDir);
			if (bridgePath) {
				args.push("-e", bridgePath);
			}
		}
	}

	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
		startTime: Date.now(),
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			// Build env: inherit current env, add PI_MCP_CONFIG if MCPs are scoped
			const spawnEnv = mcpConfigPath
				? { ...process.env, PI_MCP_CONFIG: mcpConfigPath }
				: undefined; // undefined = inherit process.env (default)

			const proc = spawn("pi", args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				...(spawnEnv ? { env: spawnEnv } : {}),
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
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
						if (!currentResult.provider && (msg as any).provider) currentResult.provider = (msg as any).provider;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		if (mcpCleanupName && teamName) {
			try {
				removeScopedMcpConfig(teamName, mcpCleanupName);
			} catch {
				/* ignore */
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
Do NOT forget to call __bg_signal(status: "done") when you finish your task.
`.trim();

function generateBgId(agentName: string, explicitId?: string): string {
	if (explicitId && !backgroundAgents.has(explicitId)) return explicitId;
	const counter = (bgAutoCounter.get(agentName) || 0) + 1;
	bgAutoCounter.set(agentName, counter);
	const id = `${agentName}-${counter}`;
	if (!backgroundAgents.has(id)) return id;
	return `${agentName}-${counter}-${Date.now().toString(36).slice(-4)}`;
}

function buildBgSpawnArgs(
	agentConfig: AgentConfig,
	mcps?: string[],
	runtimeExtensions?: string[],
	teamName?: string,
): string[] {
	const args: string[] = ["--mode", "rpc", "--no-session", "--no-extensions"];

	const agentDir = getAgentDir();
	const allExtensions = new Set<string>([
		...(agentConfig.extensions || []),
		...(runtimeExtensions || []),
	]);
	if (allExtensions.size > 0) {
		const extensionPaths = resolveExtensionPaths(agentDir, [...allExtensions]);
		for (const extPath of extensionPaths) {
			args.push("-e", extPath);
		}
	}

	if (mcps && mcps.length > 0 && teamName) {
		const bridgePath = findMcpBridgePath(agentDir);
		if (bridgePath) {
			args.push("-e", bridgePath);
		}
	}

	// Always load the bg-signal extension so __bg_signal is a real registered tool
	args.push("-e", BG_SIGNAL_EXT_PATH);

	if (agentConfig.model) args.push("--model", agentConfig.model);
	if (agentConfig.tools && agentConfig.tools.length > 0) args.push("--tools", agentConfig.tools.join(","));

	return args;
}

function launchBackgroundAgent(bgAgent: BackgroundAgent): void {
	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	// Write system prompt with __bg_signal instructions
	const fullSystemPrompt = [bgAgent.agentConfig.systemPrompt.trim(), BG_SIGNAL_INSTRUCTION]
		.filter(Boolean)
		.join("\n\n");

	if (fullSystemPrompt) {
		const tmp = writePromptToTempFile(bgAgent.agentConfig.name, fullSystemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		bgAgent.tmpPromptDir = tmpPromptDir;
		bgAgent.tmpPromptPath = tmpPromptPath;
		bgAgent.spawnArgs.push("--append-system-prompt", tmpPromptPath);
	}

	// Set up MCP config if needed
	let mcpConfigPath: string | null = null;
	if (bgAgent.mcps && bgAgent.mcps.length > 0 && bgAgent.teamName) {
		const mcpSaveAs = `bg-${bgAgent.id}-${Date.now()}`;
		mcpConfigPath = writeScopedMcpConfig(bgAgent.teamName, mcpSaveAs, bgAgent.mcps);
		bgAgent.mcpCleanupName = mcpSaveAs;
	}

	const spawnEnv = mcpConfigPath
		? { ...process.env, PI_MCP_CONFIG: mcpConfigPath }
		: undefined;

	const proc = spawn("pi", bgAgent.spawnArgs, {
		cwd: bgAgent.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		...(spawnEnv ? { env: spawnEnv } : {}),
	});

	bgAgent.proc = proc;
	bgAgent.status = "running";
	bgAgent.startTime = Date.now();
	updateBgWidget();

	let buffer = "";

	let pendingBgSignal: Record<string, string> | null = null;

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		let signalDetected: Record<string, string> | null = pendingBgSignal;

		if (event.type === "tool_call") {
			const toolName = event.name ?? event.toolCall?.name;
			const toolArgs = event.arguments ?? event.toolCall?.arguments;
			if (toolName === "__bg_signal") {
				pendingBgSignal = (toolArgs || {}) as Record<string, string>;
				signalDetected = pendingBgSignal;
			}
		}

		if (event.type === "message_end" && event.message) {
			const msg = event.message as Message;
			bgAgent.result.messages.push(msg);

			if (msg.role === "assistant") {
				for (const part of msg.content) {
					if (part.type === "toolCall" && part.name === "__bg_signal") {
						signalDetected = part.arguments as Record<string, string>;
						pendingBgSignal = signalDetected;
						break;
					}
				}

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
				if (!bgAgent.result.provider && (msg as any).provider) bgAgent.result.provider = (msg as any).provider;
				if (msg.stopReason) bgAgent.result.stopReason = msg.stopReason;
				if (msg.errorMessage) bgAgent.result.errorMessage = msg.errorMessage;

				// Emit turn progress notification (non-interrupting)
				const turnNum = bgAgent.result.usage.turns;
				const toolCalls = msg.content
					.filter((p: any) => p.type === "toolCall")
					.map((p: any) => p.name)
					.slice(0, 3);
				// Idle detection for RPC mode: if turn ended with no __bg_signal and no pending tool calls,
				// treat as implicit done
				if (msg.stopReason === "endTurn" && !signalDetected) {
					const hasPendingToolCalls = msg.content.some((p: any) => p.type === "toolCall" && p.name !== "__bg_signal");
					if (!hasPendingToolCalls && bgAgent.status === "running") {
						bgAgent.status = "done";
						bgAgent.endTime = Date.now();
						const summary = getFinalOutput(bgAgent.result.messages) || "(no output)";
						piRef?.sendMessage(
							{
								customType: "subagent-bg",
								content: `[✅ DONE from ${bgAgent.id}] ${summary.slice(0, 200)}`,
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
						killBgProcess(bgAgent);
						updateBgWidget();
					}
				}

				if (signalDetected) {
					pendingBgSignal = null;
					handleBgSignal(bgAgent, signalDetected);
				}
			}
		}

		if (event.type === "tool_result_end" && event.message) {
			bgAgent.result.messages.push(event.message as Message);
		}
	};

	proc.stdout!.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) processLine(line);
	});

	proc.stderr!.on("data", (data: Buffer) => {
		bgAgent.result.stderr += data.toString();
	});

	proc.on("close", (code: number | null) => {
		if (buffer.trim()) processLine(buffer);
		bgAgent.result.exitCode = code ?? 0;

		// Only finalize if not already done by __bg_signal
		if (bgAgent.status === "running" || bgAgent.status === "waiting") {
			bgAgent.status = code === 0 ? "done" : "error";
			bgAgent.endTime = Date.now();

			const summary = getFinalOutput(bgAgent.result.messages) || "(no output)";
			const icon = bgAgent.status === "done" ? "✅ DONE" : "❌ ERROR";
			piRef?.sendMessage(
				{
					customType: "subagent-bg",
					content: `[${icon} from ${bgAgent.id}] ${summary.slice(0, 200)}`,
					display: true,
				},
				{ triggerTurn: true },
			);

			// Save output in team mode
			if (bgAgent.teamName && bgAgent.saveAs && bgAgent.status === "done") {
				const output = getFinalOutput(bgAgent.result.messages);
				if (output) {
					saveOutput(bgAgent.teamName, bgAgent.saveAs, output);
					bgAgent.result.savedAs = bgAgent.saveAs;
				}
			}
		}

		cleanupBgAgent(bgAgent);
		updateBgWidget();
		trySpawnQueued();
	});

	proc.on("error", () => {
		bgAgent.result.exitCode = 1;
		if (bgAgent.status === "running" || bgAgent.status === "waiting") {
			bgAgent.status = "error";
			bgAgent.endTime = Date.now();
			piRef?.sendMessage(
				{
					customType: "subagent-bg",
					content: `[❌ ERROR from ${bgAgent.id}] Process failed to start`,
					display: true,
				},
				{ triggerTurn: true },
			);
		}
		cleanupBgAgent(bgAgent);
		updateBgWidget();
		trySpawnQueued();
	});

	// Send initial prompt via stdin
	const prompt = JSON.stringify({ type: "prompt", message: `Task: ${bgAgent.task}` }) + "\n";
	proc.stdin!.write(prompt);

	piRef?.sendMessage(
		{
			customType: "subagent-bg",
			content: `[🚀 STARTED ${bgAgent.id}] ${bgAgent.agent} — ${bgAgent.task.slice(0, 100)}`,
			display: true,
		},
		{ triggerTurn: false },
	);
}

function handleBgSignal(bgAgent: BackgroundAgent, args: Record<string, string>): void {
	const signalStatus = args.status;
	const summary = args.summary || args.question || args.error || "";

	if (signalStatus === "done") {
		bgAgent.status = "done";
		bgAgent.endTime = Date.now();
		piRef?.sendMessage(
			{
				customType: "subagent-bg",
				content: `[✅ DONE from ${bgAgent.id}] ${summary.slice(0, 300)}`,
				display: true,
			},
			{ triggerTurn: true },
		);
		// Save output in team mode
		if (bgAgent.teamName && bgAgent.saveAs) {
			const output = getFinalOutput(bgAgent.result.messages);
			if (output) {
				saveOutput(bgAgent.teamName, bgAgent.saveAs, output);
				bgAgent.result.savedAs = bgAgent.saveAs;
			}
		}
		killBgProcess(bgAgent);
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
		// Process stays alive — waiting for steer
	} else if (signalStatus === "error") {
		bgAgent.status = "error";
		bgAgent.endTime = Date.now();
		piRef?.sendMessage(
			{
				customType: "subagent-bg",
				content: `[❌ ERROR from ${bgAgent.id}] ${summary.slice(0, 300)}`,
				display: true,
			},
			{ triggerTurn: true },
		);
		killBgProcess(bgAgent);
		updateBgWidget();
	}
}

function killBgProcess(bgAgent: BackgroundAgent): void {
	if (!bgAgent.proc) return;
	const proc = bgAgent.proc;

	// Track if process has actually exited
	let exited = false;
	const onExit = () => {
		exited = true;
	};
	proc.once("exit", onExit);

	try {
		proc.kill("SIGTERM");
	} catch {
		/* already dead */
		return;
	}

	setTimeout(() => {
		if (!exited) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
		}
		proc.removeListener("exit", onExit);
	}, 5000);
}

function cleanupBgAgent(bgAgent: BackgroundAgent): void {
	if (bgAgent.tmpPromptPath) {
		try { fs.unlinkSync(bgAgent.tmpPromptPath); } catch { /* ignore */ }
	}
	if (bgAgent.tmpPromptDir) {
		try { fs.rmdirSync(bgAgent.tmpPromptDir); } catch { /* ignore */ }
	}
	if (bgAgent.mcpCleanupName && bgAgent.teamName) {
		try { removeScopedMcpConfig(bgAgent.teamName, bgAgent.mcpCleanupName); } catch { /* ignore */ }
	}
}

function trySpawnQueued(): void {
	const runningCount = [...backgroundAgents.values()].filter(
		(a) => a.status === "running" || a.status === "waiting",
	).length;

	if (runningCount >= MAX_BG_CONCURRENCY) return;

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

function shutdownAllBackgroundAgents(): void {
	for (const bgAgent of backgroundAgents.values()) {
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
	updateBgWidget();
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	saveAs: Type.Optional(
		Type.String({ description: "Name for saved output in team mode (default: agent name, or agent-N for parallel)" }),
	),
	mcps: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"MCP server names this agent needs (e.g. [\"grokt-mcp\", \"dev-mcp\"]). " +
				"Only these MCPs are loaded. Omit for no MCPs (fastest). Requires team mode.",
		}),
	),
	extensions: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Extension names this agent needs (e.g. [\"slack\", \"observe\"]). " +
				"Only these extensions are loaded. Merged with agent's frontmatter extensions. Omit for none.",
		}),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	saveAs: Type.Optional(
		Type.String({ description: "Name for saved output in team mode (default: agent name)" }),
	),
	mcps: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"MCP server names this agent needs (e.g. [\"grokt-mcp\", \"dev-mcp\"]). " +
				"Only these MCPs are loaded. Omit for no MCPs (fastest). Requires team mode.",
		}),
	),
	extensions: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Extension names this agent needs (e.g. [\"slack\", \"observe\"]). " +
				"Only these extensions are loaded. Merged with agent's frontmatter extensions. Omit for none.",
		}),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
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
				"MCP server names this agent needs (e.g. [\"grokt-mcp\", \"dev-mcp\"]). " +
				"Only these MCPs are loaded. Omit for no MCPs (fastest). Requires team mode.",
		}),
	),
	extensions: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Extension names this agent needs (e.g. [\"slack\", \"observe\"]). " +
				"Only these extensions are loaded. Merged with agent's frontmatter extensions. Omit for none.",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run the agent in background (non-blocking). Returns immediately with a job ID. " +
				"Use subagent_status to check progress, subagent_steer to send messages, subagent_stop to kill. " +
				"Single mode only in V1.",
			default: false,
		}),
	),
});

export default function (pi: ExtensionAPI) {
	piRef = pi;
	// Register team coordination tools (TeamCreate, TaskCreate, SendMessage, etc.)
	registerCoordinationTools(pi);

	// Capture UI context for belowEditor widget updates
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) {
			uiSetWidget = ctx.ui.setWidget.bind(ctx.ui);
		}
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
			"Team mode: set team param to enable shared context + named outputs. Use {output:name} in tasks to reference previous agent outputs.",
			"Manage teams: /team new|info|outputs|delete <name>.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const teamName = params.team || undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
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
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (params.background && (hasChain || hasTasks)) {
				return {
					content: [{ type: "text", text: "background: true is only supported in single mode (V1). Use agent + task." }],
					details: makeDetails(hasChain ? "chain" : "parallel")([]),
					isError: true,
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
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

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					let taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Team mode: expand output placeholders and prepend shared context
					if (teamName) taskWithContext = buildTeamTask(teamName, taskWithContext);

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
						ctx.cwd, agents, step.agent, taskWithContext, step.cwd, i + 1, signal, chainUpdate, makeDetails("chain"),
						step.mcps, step.extensions, teamName,
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
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
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
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

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					// Team mode: expand output placeholders and prepend shared context
					const taskText = teamName ? buildTeamTask(teamName, t.task) : t.task;
					const outputName = t.saveAs || (params.tasks!.length > 1 ? `${t.agent}-${index + 1}` : t.agent);

					const result = await runSingleAgent(
						ctx.cwd, agents, t.agent, taskText, t.cwd, undefined, signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						t.mcps, t.extensions, teamName,
					);

					// Team mode: save named output
					if (teamName && result.exitCode === 0) {
						const output = getFinalOutput(result.messages);
						if (output) {
							saveOutput(teamName, outputName, output);
							result.savedAs = outputName;
						}
					}

					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
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

			if (params.agent && params.task) {
				// ── Background mode ──
				if (params.background) {
					if (!params.agent || !params.task) {
						return {
							content: [{ type: "text", text: "background: true requires single mode (agent + task)." }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}

					const taskText = teamName ? buildTeamTask(teamName, params.task) : params.task;
					const agentConfig = agents.find((a) => a.name === params.agent);
					if (!agentConfig) {
						const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
						return {
							content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}

					const jobId = generateBgId(params.agent, params.saveAs);
					const saveAs = params.saveAs || params.agent;

					// Build spawn args (same as runSingleAgent but --mode rpc)
					const spawnArgs = buildBgSpawnArgs(agentConfig, params.mcps, params.extensions, teamName);

					// Check concurrency
					const runningCount = [...backgroundAgents.values()].filter(
						(a) => a.status === "running" || a.status === "waiting",
					).length;

					const bgAgent: BackgroundAgent = {
						id: jobId,
						agent: params.agent,
						task: taskText,
						proc: null,
						result: {
							agent: params.agent,
							agentSource: agentConfig.source,
							task: taskText,
							exitCode: -1,
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							startTime: Date.now(),
						},
						status: runningCount >= MAX_BG_CONCURRENCY ? "queued" : "running",
						startTime: Date.now(),
						cwd: params.cwd ?? ctx.cwd,
						agentConfig,
						spawnArgs,
						teamName,
						saveAs,
						extensions: params.extensions,
						mcps: params.mcps,
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
										? `Background agent queued: ${jobId} (${bgAgent.agent})\nStatus: queued — ${runningCount}/${MAX_BG_CONCURRENCY} slots in use\nUse subagent_status(id: "${jobId}") to check progress.`
										: `Background agent started: ${jobId} (${bgAgent.agent})\nStatus: running\nUse subagent_status(id: "${jobId}") to check progress.`,
							},
						],
						details: makeDetails("single")([bgAgent.result]),
					};
				}

				// Team mode: expand output placeholders and prepend shared context
				const taskText = teamName ? buildTeamTask(teamName, params.task) : params.task;
				const outputName = params.saveAs || params.agent;

				const result = await runSingleAgent(
					ctx.cwd, agents, params.agent, taskText, params.cwd, undefined, signal, onUpdate, makeDetails("single"),
					params.mcps, params.extensions, teamName,
				);

				// Team mode: save named output
				if (teamName && result.exitCode === 0) {
					const output = getFinalOutput(result.messages);
					if (output) {
						saveOutput(teamName, outputName, output);
						result.savedAs = outputName;
					}
				}

				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";

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
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
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
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
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
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
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
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model, {
						provider: r.provider,
						elapsedMs: Date.now() - r.startTime,
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
				const usageStr = formatUsageStats(r.usage, r.model, {
					provider: r.provider,
					elapsedMs: Date.now() - r.startTime,
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
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
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
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model, {
							provider: r.provider,
							elapsedMs: Date.now() - r.startTime,
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
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
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
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model, {
							provider: r.provider,
							elapsedMs: Date.now() - r.startTime,
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
							: r.exitCode === 0
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
			const bgAgent = backgroundAgents.get(params.id);
			if (!bgAgent) {
				return {
					content: [{ type: "text", text: `No background agent found with id "${params.id}"` }],
					isError: true,
				};
			}
			if (bgAgent.status !== "running" && bgAgent.status !== "waiting") {
				return {
					content: [{ type: "text", text: `Agent "${params.id}" is ${bgAgent.status}, cannot steer.` }],
					isError: true,
				};
			}
			if (!bgAgent.proc || bgAgent.proc.killed) {
				return {
					content: [{ type: "text", text: `Agent "${params.id}" process is not alive.` }],
					isError: true,
				};
			}

			if (params.interrupt) {
				bgAgent.proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
				// Brief pause before sending new prompt
				await new Promise((r) => setTimeout(r, 500));
			}

			const steerMsg = bgAgent.status === "waiting"
				? JSON.stringify({ type: "prompt", message: params.message }) + "\n"
				: JSON.stringify({ type: "steer", message: params.message }) + "\n";

			bgAgent.proc.stdin!.write(steerMsg);
			if (bgAgent.status === "waiting") {
				bgAgent.status = "running";
				updateBgWidget();
			}

			return {
				content: [
					{
						type: "text",
						text: `Steered "${params.id}": ${params.interrupt ? "(interrupted) " : ""}${params.message.slice(0, 100)}`,
					},
				],
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
				const bgAgent = backgroundAgents.get(params.id);
				if (!bgAgent) {
					return {
						content: [{ type: "text", text: `No background agent found with id "${params.id}"` }],
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
				const usageStr = formatUsageStats(bgAgent.result.usage, bgAgent.result.model, {
					provider: bgAgent.result.provider,
					elapsedMs,
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
								`Task: ${bgAgent.task.slice(0, 150)}`,
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
				};
			}

			// All agents summary
			const entries = [...backgroundAgents.values()];
			if (entries.length === 0) {
				return { content: [{ type: "text", text: "No background agents." }] };
			}

			const queuedEntries = entries.filter((a) => a.status === "queued");
			const queuePositions = new Map(queuedEntries.map((a, index) => [a.id, index + 1]));
			const lines = entries.map((a) => {
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

			const running = entries.filter((a) => a.status === "running" || a.status === "waiting").length;
			const queued = entries.filter((a) => a.status === "queued").length;

			return {
				content: [
					{
						type: "text",
						text: `Background agents (${running} running, ${queued} queued):\n${lines.join("\n")}`,
					},
				],
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
			const bgAgent = backgroundAgents.get(params.id);
			if (!bgAgent) {
				return {
					content: [{ type: "text", text: `No background agent found with id "${params.id}"` }],
					isError: true,
				};
			}

			if (bgAgent.status === "done" || bgAgent.status === "error" || bgAgent.status === "aborted") {
				return {
					content: [{ type: "text", text: `Agent "${params.id}" already ${bgAgent.status}.` }],
				};
			}

			const wasQueued = bgAgent.status === "queued";
			bgAgent.status = "aborted";
			bgAgent.endTime = Date.now();

			if (!wasQueued) {
				killBgProcess(bgAgent);
			}

			// Save partial output in team mode
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

			updateBgWidget();

			if (wasQueued) {
				trySpawnQueued();
			}

			return {
				content: [
					{
						type: "text",
						text: `Stopped "${params.id}". ${bgAgent.result.usage.turns} turns completed before abort.`,
					},
				],
			};
		},
		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// ── Session cleanup ──────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		shutdownAllBackgroundAgents();
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
					"success",
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
				ctx.ui.notify(`Team "${teamArg}" deleted.`, "success");
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
