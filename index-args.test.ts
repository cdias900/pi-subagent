/**
 * Tests for the foreground/background spawn-isolation arg helpers.
 *
 * These tests exercise the pure, exported helpers from index.ts:
 *   - buildModelArgs
 *   - buildForegroundToolArgs
 *   - buildBackgroundToolArgs
 *   - buildSystemPromptArgs
 *
 * They also build full legacy argument snapshots for the bundled agents
 * (scout/planner/executor/reviewer) in both foreground and background modes,
 * verifying that the exact arg ordering is preserved and no unrelated args drift.
 *
 * Importing index.ts does NOT trigger extension registration — the default export
 * (the extension entry point) is only invoked by pi when loading the extension,
 * never at module-eval time.
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildModelArgs,
	buildForegroundToolArgs,
	buildBackgroundToolArgs,
	buildSystemPromptArgs,
	buildIsolationArgs,
} from "./index.js";
import { loadAgentsFromDir, type AgentConfig } from "./agents.js";

const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

/** Load the four bundled agents keyed by name. */
function loadBundledAgents(): Record<string, AgentConfig> {
	const diagnostics: string[] = [];
	const agents = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled", diagnostics);
	expect(diagnostics).toEqual([]);
	const map: Record<string, AgentConfig> = {};
	for (const a of agents) map[a.name] = a;
	return map;
}

const BUNDLED = loadBundledAgents();

// Fixed placeholders for dynamic values so snapshots are deterministic.
const PROMPT_PATH = "/tmp/PROMPT.md";
const TASK_PROMPT = "do the thing";
const MODEL = "claude-sonnet-4";

// ── Foreground tool args ───────────────────────────────────────────

describe("buildForegroundToolArgs", () => {
	it("omitted tools => no flag", () => {
		expect(buildForegroundToolArgs(undefined)).toEqual([]);
	});

	it("empty tools [] => --no-tools", () => {
		expect(buildForegroundToolArgs([])).toEqual(["--no-tools"]);
	});

	it("non-empty tools => --tools comma-list", () => {
		expect(buildForegroundToolArgs(["read", "write", "bash"])).toEqual([
			"--tools",
			"read,write,bash",
		]);
	});

	it("single tool => --tools single", () => {
		expect(buildForegroundToolArgs(["read"])).toEqual(["--tools", "read"]);
	});

	it("does NOT append __bg_signal (foreground)", () => {
		expect(buildForegroundToolArgs(["read", "write"])).toEqual([
			"--tools",
			"read,write",
		]);
		expect(buildForegroundToolArgs(["read", "write"]).join(",")).not.toContain("__bg_signal");
	});
});

// ── Background tool args ───────────────────────────────────────────

describe("buildBackgroundToolArgs", () => {
	it("omitted tools => no flag (existing behavior)", () => {
		expect(buildBackgroundToolArgs(undefined)).toEqual([]);
	});

	it("empty tools [] => --tools __bg_signal (only the lifecycle tool; no task tools)", () => {
		expect(buildBackgroundToolArgs([])).toEqual(["--tools", "__bg_signal"]);
	});

	it("non-empty tools => appends __bg_signal without duplicates", () => {
		expect(buildBackgroundToolArgs(["read", "write"])).toEqual([
			"--tools",
			"read,write,__bg_signal",
		]);
	});

	it("non-empty tools already containing __bg_signal => no duplicate", () => {
		expect(buildBackgroundToolArgs(["read", "__bg_signal"])).toEqual([
			"--tools",
			"read,__bg_signal",
		]);
	});

	it("__bg_signal alone => kept, no duplicate", () => {
		expect(buildBackgroundToolArgs(["__bg_signal"])).toEqual([
			"--tools",
			"__bg_signal",
		]);
	});

	it("single real tool => appends __bg_signal", () => {
		expect(buildBackgroundToolArgs(["read"])).toEqual(["--tools", "read,__bg_signal"]);
	});
});

// ── System prompt + isolation args ─────────────────────────────────

describe("buildSystemPromptArgs", () => {
	it("default (undefined mode) => --append-system-prompt, no isolation flags", () => {
		expect(
			buildSystemPromptArgs({ systemPromptMode: undefined, promptFilePath: PROMPT_PATH }),
		).toEqual(["--append-system-prompt", PROMPT_PATH]);
	});

	it("append mode => --append-system-prompt, no isolation flags", () => {
		expect(
			buildSystemPromptArgs({ systemPromptMode: "append", promptFilePath: PROMPT_PATH }),
		).toEqual(["--append-system-prompt", PROMPT_PATH]);
	});

	it("replace mode => --system-prompt + auto --no-skills/--no-prompt-templates/--no-context-files", () => {
		expect(
			buildSystemPromptArgs({ systemPromptMode: "replace", promptFilePath: PROMPT_PATH }),
		).toEqual([
			"--system-prompt",
			PROMPT_PATH,
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
		]);
	});

	it("replace mode ignores individual no* flags (already auto-added)", () => {
		// Even if individually set, replace mode produces exactly one copy of each.
		const result = buildSystemPromptArgs({
			systemPromptMode: "replace",
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			promptFilePath: PROMPT_PATH,
		});
		expect(result).toEqual([
			"--system-prompt",
			PROMPT_PATH,
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
		]);
		expect(result.filter((f) => f === "--no-skills")).toHaveLength(1);
		expect(result.filter((f) => f === "--no-prompt-templates")).toHaveLength(1);
		expect(result.filter((f) => f === "--no-context-files")).toHaveLength(1);
	});

	it("append mode with noSkills: true => adds only --no-skills", () => {
		expect(
			buildSystemPromptArgs({
				systemPromptMode: "append",
				noSkills: true,
				promptFilePath: PROMPT_PATH,
			}),
		).toEqual(["--append-system-prompt", PROMPT_PATH, "--no-skills"]);
	});

	it("append mode with noPromptTemplates: true => adds only --no-prompt-templates", () => {
		expect(
			buildSystemPromptArgs({
				systemPromptMode: "append",
				noPromptTemplates: true,
				promptFilePath: PROMPT_PATH,
			}),
		).toEqual(["--append-system-prompt", PROMPT_PATH, "--no-prompt-templates"]);
	});

	it("append mode with noContextFiles: true => adds only --no-context-files", () => {
		expect(
			buildSystemPromptArgs({
				systemPromptMode: "append",
				noContextFiles: true,
				promptFilePath: PROMPT_PATH,
			}),
		).toEqual(["--append-system-prompt", PROMPT_PATH, "--no-context-files"]);
	});

	it("append mode with all three no* true => adds all three", () => {
		expect(
			buildSystemPromptArgs({
				systemPromptMode: "append",
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				promptFilePath: PROMPT_PATH,
			}),
		).toEqual([
			"--append-system-prompt",
			PROMPT_PATH,
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
		]);
	});

	it("append mode with all no* false => no isolation flags", () => {
		expect(
			buildSystemPromptArgs({
				systemPromptMode: "append",
				noSkills: false,
				noPromptTemplates: false,
				noContextFiles: false,
				promptFilePath: PROMPT_PATH,
			}),
		).toEqual(["--append-system-prompt", PROMPT_PATH]);
	});

	it("default mode with noSkills: true => adds --no-skills", () => {
		expect(
			buildSystemPromptArgs({ noSkills: true, promptFilePath: PROMPT_PATH }),
		).toEqual(["--append-system-prompt", PROMPT_PATH, "--no-skills"]);
	});

	it("partial no* flags: only true ones honored", () => {
		expect(
			buildSystemPromptArgs({
				noSkills: false,
				noPromptTemplates: true,
				noContextFiles: false,
				promptFilePath: PROMPT_PATH,
			}),
		).toEqual(["--append-system-prompt", PROMPT_PATH, "--no-prompt-templates"]);
	});
});

// ── Isolation args (no prompt file) ────────────────────────────────

describe("buildIsolationArgs", () => {
	it("all omitted => no flags", () => {
		expect(buildIsolationArgs({})).toEqual([]);
	});

	it("all false => no flags", () => {
		expect(
			buildIsolationArgs({
				noSkills: false,
				noPromptTemplates: false,
				noContextFiles: false,
			}),
		).toEqual([]);
	});

	it("noSkills: true => only --no-skills", () => {
		expect(buildIsolationArgs({ noSkills: true })).toEqual(["--no-skills"]);
	});

	it("noPromptTemplates: true => only --no-prompt-templates", () => {
		expect(buildIsolationArgs({ noPromptTemplates: true })).toEqual([
			"--no-prompt-templates",
		]);
	});

	it("noContextFiles: true => only --no-context-files", () => {
		expect(buildIsolationArgs({ noContextFiles: true })).toEqual([
			"--no-context-files",
		]);
	});

	it("all true => all three, in fixed order", () => {
		expect(
			buildIsolationArgs({
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			}),
		).toEqual(["--no-skills", "--no-prompt-templates", "--no-context-files"]);
	});

	it("partial: only true ones honored, in fixed order", () => {
		expect(
			buildIsolationArgs({
				noSkills: false,
				noPromptTemplates: true,
				noContextFiles: true,
			}),
		).toEqual(["--no-prompt-templates", "--no-context-files"]);
	});

	it("never emits a prompt flag", () => {
		const all = buildIsolationArgs({
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		expect(all).not.toContain("--append-system-prompt");
		expect(all).not.toContain("--system-prompt");
	});
});

// ── Legacy argument snapshots for bundled agents ───────────────────
//
// These reconstruct the exact spawn arg arrays that runSingleAgent
// (foreground) and buildBgSpawnArgs (background) produce for each bundled
// agent, using the same helper calls and ordering as index.ts. This catches
// any unrelated arg drift and documents the preserved legacy ordering.

/**
 * Reconstruct the foreground (runSingleAgent) spawn args for an agent.
 * Mirrors the exact arg sequence in index.ts::runSingleAgent.
 */
function foregroundArgs(agent: AgentConfig): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	// These fixtures supply only the frontmatter model; they do not reconstruct
	// parent or session model context. Bundled snapshot agents are model-less.
	args.push(...buildModelArgs({ model: agent.model }));
	args.push(...buildForegroundToolArgs(agent.tools));
	const hasPromptBody = agent.systemPrompt.trim().length > 0;
	const isReplace = agent.systemPromptMode === "replace";
	if (hasPromptBody || isReplace) {
		// Mirrors index.ts::runSingleAgent: a prompt file is written (possibly empty
		// for replace mode with an empty body) and buildSystemPromptArgs is used.
		args.push(
			...buildSystemPromptArgs({
				systemPromptMode: agent.systemPromptMode,
				noSkills: agent.noSkills,
				noPromptTemplates: agent.noPromptTemplates,
				noContextFiles: agent.noContextFiles,
				promptFilePath: PROMPT_PATH,
			}),
		);
	} else {
		// Empty body, append/default: no prompt flag, but honor individual isolation flags.
		args.push(
			...buildIsolationArgs({
				noSkills: agent.noSkills,
				noPromptTemplates: agent.noPromptTemplates,
				noContextFiles: agent.noContextFiles,
			}),
		);
	}
	args.push(TASK_PROMPT);
	return args;
}

/**
 * Reconstruct the background (buildBgSpawnArgs) spawn args for an agent.
 * Mirrors the exact arg sequence in index.ts::buildBgSpawnArgs, including
 * the always-on bg-signal extension flag. The system-prompt args appended
 * later by launchBackgroundAgent are added via buildSystemPromptArgs to
 * reflect the full post-launch arg array.
 */
function backgroundArgs(agent: AgentConfig): string[] {
	const args: string[] = ["--mode", "rpc", "--no-session", "--no-extensions"];
	// These fixtures supply only the frontmatter model; they do not reconstruct
	// parent or session model context. Bundled snapshot agents are model-less.
	args.push("-e", "<bg-signal-ext>");
	args.push(...buildModelArgs({ model: agent.model }));
	args.push(...buildBackgroundToolArgs(agent.tools));
	// launchBackgroundAgent always builds a non-empty fullSystemPrompt because it
	// appends the always-present BG_SIGNAL_INSTRUCTION to the agent body, so the
	// system-prompt args are always emitted (even for an empty-body agent). Mirror
	// that here rather than gating on agent.systemPrompt.trim().
	args.push(
		...buildSystemPromptArgs({
			systemPromptMode: agent.systemPromptMode,
			noSkills: agent.noSkills,
			noPromptTemplates: agent.noPromptTemplates,
			noContextFiles: agent.noContextFiles,
			promptFilePath: PROMPT_PATH,
		}),
	);
	return args;
}

describe("bundled agent foreground snapshots", () => {
	it("scout", () => {
		expect(foregroundArgs(BUNDLED.scout)).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--tools",
			"read,grep,find,ls,bash",
			"--append-system-prompt",
			PROMPT_PATH,
			TASK_PROMPT,
		]);
	});

	it("planner", () => {
		expect(foregroundArgs(BUNDLED.planner)).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--tools",
			"read,write,grep,find,ls",
			"--append-system-prompt",
			PROMPT_PATH,
			TASK_PROMPT,
		]);
	});

	it("reviewer", () => {
		expect(foregroundArgs(BUNDLED.reviewer)).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--tools",
			"read,grep,find,ls,bash",
			"--append-system-prompt",
			PROMPT_PATH,
			TASK_PROMPT,
		]);
	});

	it("executor (tools omitted => no --tools flag)", () => {
		expect(foregroundArgs(BUNDLED.executor)).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--append-system-prompt",
			PROMPT_PATH,
			TASK_PROMPT,
		]);
	});

	it("all bundled foreground args use --append-system-prompt (no replace/isolation flags)", () => {
		for (const name of ["scout", "planner", "reviewer", "executor"]) {
			const args = foregroundArgs(BUNDLED[name]);
			expect(args).toContain("--append-system-prompt");
			expect(args).not.toContain("--system-prompt");
			expect(args).not.toContain("--no-skills");
			expect(args).not.toContain("--no-prompt-templates");
			expect(args).not.toContain("--no-context-files");
		}
	});

	it("no bundled foreground args contain --no-tools (none have tools: [])", () => {
		for (const name of ["scout", "planner", "reviewer", "executor"]) {
			expect(foregroundArgs(BUNDLED[name])).not.toContain("--no-tools");
		}
	});
});

// ── Empty-body foreground isolation behavior ───────────────────────
//
// runSingleAgent must honor isolation flags even when an agent has no
// system-prompt body. These tests reconstruct the foreground arg array via
// foregroundArgs(), which mirrors runSingleAgent's branching exactly.

/** Build an empty-body AgentConfig with the given frontmatter overrides. */
function emptyBodyAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "empty-body",
		description: "empty-body test agent",
		source: "bundled",
		filePath: "/tmp/empty-body.md",
		systemPrompt: "",
		systemPromptMode: undefined,
		noSkills: undefined,
		noPromptTemplates: undefined,
		noContextFiles: undefined,
		tools: undefined,
		extensions: undefined,
		model: undefined,
		...overrides,
	};
}

describe("empty-body foreground isolation", () => {
	it("empty body, append/default, no isolation => only base + task prompt", () => {
		expect(foregroundArgs(emptyBodyAgent())).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			TASK_PROMPT,
		]);
	});

	it("empty body, append/default, noContextFiles: true => --no-context-files emitted", () => {
		expect(foregroundArgs(emptyBodyAgent({ noContextFiles: true }))).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-context-files",
			TASK_PROMPT,
		]);
	});

	it("empty body, append mode, noSkills: true => --no-skills emitted", () => {
		expect(
			foregroundArgs(emptyBodyAgent({ systemPromptMode: "append", noSkills: true })),
		).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			TASK_PROMPT,
		]);
	});

	it("empty body, default mode, all three no* true => all three emitted", () => {
		expect(
			foregroundArgs(
				emptyBodyAgent({
					noSkills: true,
					noPromptTemplates: true,
					noContextFiles: true,
				}),
			),
		).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			TASK_PROMPT,
		]);
	});

	it("empty body, default mode, partial no* flags => only true ones", () => {
		expect(
			foregroundArgs(
				emptyBodyAgent({
					noSkills: false,
					noPromptTemplates: true,
					noContextFiles: false,
				}),
			),
		).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-prompt-templates",
			TASK_PROMPT,
		]);
	});

	it("empty body, replace mode => --system-prompt + all three --no-* (prompt still replaced)", () => {
		expect(
			foregroundArgs(emptyBodyAgent({ systemPromptMode: "replace" })),
		).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--system-prompt",
			PROMPT_PATH,
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			TASK_PROMPT,
		]);
	});

	it("empty body, replace mode ignores individual no* flags (no duplicates)", () => {
		const args = foregroundArgs(
			emptyBodyAgent({
				systemPromptMode: "replace",
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			}),
		);
		expect(args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--system-prompt",
			PROMPT_PATH,
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			TASK_PROMPT,
		]);
		expect(args.filter((f) => f === "--no-skills")).toHaveLength(1);
		expect(args.filter((f) => f === "--no-prompt-templates")).toHaveLength(1);
		expect(args.filter((f) => f === "--no-context-files")).toHaveLength(1);
	});

	it("empty body, append/default never emits a prompt flag", () => {
		const args = foregroundArgs(
			emptyBodyAgent({ noSkills: true, noPromptTemplates: true, noContextFiles: true }),
		);
		expect(args).not.toContain("--append-system-prompt");
		expect(args).not.toContain("--system-prompt");
	});
});

describe("bundled agent background snapshots", () => {
	it("scout (nonempty tools => __bg_signal appended)", () => {
		expect(backgroundArgs(BUNDLED.scout)).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"-e",
			"<bg-signal-ext>",
			"--tools",
			"read,grep,find,ls,bash,__bg_signal",
			"--append-system-prompt",
			PROMPT_PATH,
		]);
	});

	it("planner (nonempty tools => __bg_signal appended)", () => {
		expect(backgroundArgs(BUNDLED.planner)).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"-e",
			"<bg-signal-ext>",
			"--tools",
			"read,write,grep,find,ls,__bg_signal",
			"--append-system-prompt",
			PROMPT_PATH,
		]);
	});

	it("reviewer (nonempty tools => __bg_signal appended)", () => {
		expect(backgroundArgs(BUNDLED.reviewer)).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"-e",
			"<bg-signal-ext>",
			"--tools",
			"read,grep,find,ls,bash,__bg_signal",
			"--append-system-prompt",
			PROMPT_PATH,
		]);
	});

	it("executor (tools omitted => no --tools flag, __bg_signal via extension only)", () => {
		expect(backgroundArgs(BUNDLED.executor)).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"-e",
			"<bg-signal-ext>",
			"--append-system-prompt",
			PROMPT_PATH,
		]);
	});

	it("all bundled background args include the bg-signal extension flag", () => {
		for (const name of ["scout", "planner", "reviewer", "executor"]) {
			const args = backgroundArgs(BUNDLED[name]);
			expect(args).toContain("-e");
			expect(args).toContain("<bg-signal-ext>");
		}
	});

	it("all bundled background args use --append-system-prompt", () => {
		for (const name of ["scout", "planner", "reviewer", "executor"]) {
			const args = backgroundArgs(BUNDLED[name]);
			expect(args).toContain("--append-system-prompt");
			expect(args).not.toContain("--system-prompt");
		}
	});

	it("no bundled background args contain --no-tools (none have tools: [])", () => {
		for (const name of ["scout", "planner", "reviewer", "executor"]) {
			expect(backgroundArgs(BUNDLED[name])).not.toContain("--no-tools");
		}
	});

	it("background empty tools uses --tools __bg_signal (only lifecycle tool, no task tools)", () => {
		// Foreground empty disables ALL tools (--no-tools). Background empty must keep the
		// __bg_signal lifecycle tool active so the RPC completion protocol still works, while
		// disabling every task tool (built-in, extension, and MCP). --tools is a name
		// allowlist, so listing only __bg_signal achieves both without --no-builtin-tools.
		expect(buildBackgroundToolArgs([])).toEqual(["--tools", "__bg_signal"]);
		expect(buildBackgroundToolArgs([])).not.toContain("--no-tools");
		expect(buildForegroundToolArgs([])).toEqual(["--no-tools"]);
		expect(buildForegroundToolArgs([])).not.toContain("--tools");
	});
});

// ── No unrelated arg drift ─────────────────────────────────────────

describe("no unrelated arg drift", () => {
	it("foreground base args are exactly the legacy set", () => {
		// executor has no tools and no model — purest base.
		const base = foregroundArgs(BUNDLED.executor);
		expect(base.slice(0, 5)).toEqual(["--mode", "json", "-p", "--no-session", "--no-extensions"]);
	});

	it("background base args are exactly the legacy set + bg-signal ext", () => {
		const base = backgroundArgs(BUNDLED.executor);
		expect(base.slice(0, 6)).toEqual([
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"-e",
			"<bg-signal-ext>",
		]);
	});

	it("foreground uses json mode, never rpc; no duplicate base flags", () => {
		for (const name of ["scout", "planner", "reviewer", "executor"]) {
			const args = foregroundArgs(BUNDLED[name]);
			// --mode appears exactly once and is always json (never rpc)
			expect(args.filter((a) => a === "--mode").length).toBe(1);
			expect(args).toContain("json");
			expect(args).not.toContain("rpc");
			// --no-extensions appears exactly once
			expect(args.filter((a) => a === "--no-extensions").length).toBe(1);
			// -p appears exactly once
			expect(args.filter((a) => a === "-p").length).toBe(1);
			// --no-session appears exactly once
			expect(args.filter((a) => a === "--no-session").length).toBe(1);
		}
	});

	it("tools flag ordering preserved: --tools always after base and before prompt args", () => {
		for (const name of ["scout", "planner", "reviewer"]) {
			const fg = foregroundArgs(BUNDLED[name]);
			const toolsIdx = fg.indexOf("--tools");
			const baseEnd = fg.indexOf("--no-extensions");
			const promptIdx = fg.indexOf("--append-system-prompt");
			expect(toolsIdx).toBeGreaterThan(baseEnd);
			expect(toolsIdx).toBeLessThan(promptIdx);
		}
	});

	it("background tools flag ordering preserved: --tools after bg-signal ext", () => {
		for (const name of ["scout", "planner", "reviewer"]) {
			const bg = backgroundArgs(BUNDLED[name]);
			const toolsIdx = bg.indexOf("--tools");
			const extIdx = bg.indexOf("<bg-signal-ext>");
			expect(toolsIdx).toBeGreaterThan(extIdx);
		}
	});

	it("foreground model/thinking flags stay after extension setup and before tools and prompt", () => {
		const args = foregroundArgs({
			...BUNDLED.scout,
			model: "provider/base:high",
		});
		const extensionIdx = args.indexOf("--no-extensions");
		const modelIdx = args.indexOf("--model");
		const thinkingIdx = args.indexOf("--thinking");
		const toolsIdx = args.indexOf("--tools");
		const systemPromptIdx = args.indexOf("--append-system-prompt");
		const taskPromptIdx = args.indexOf(TASK_PROMPT);

		expect(extensionIdx).toBeLessThan(modelIdx);
		expect(modelIdx).toBeLessThan(thinkingIdx);
		expect(thinkingIdx).toBeLessThan(toolsIdx);
		expect(toolsIdx).toBeLessThan(systemPromptIdx);
		expect(systemPromptIdx).toBeLessThan(taskPromptIdx);
	});

	it("background model/thinking flags stay after extensions and before tools and prompt", () => {
		const args = backgroundArgs({
			...BUNDLED.scout,
			model: "provider/base:high",
		});
		const extensionIdx = args.indexOf("<bg-signal-ext>");
		const modelIdx = args.indexOf("--model");
		const thinkingIdx = args.indexOf("--thinking");
		const toolsIdx = args.indexOf("--tools");
		const promptIdx = args.indexOf("--append-system-prompt");

		expect(extensionIdx).toBeLessThan(modelIdx);
		expect(modelIdx).toBeLessThan(thinkingIdx);
		expect(thinkingIdx).toBeLessThan(toolsIdx);
		expect(toolsIdx).toBeLessThan(promptIdx);
	});
});
