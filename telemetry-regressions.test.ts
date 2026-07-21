/**
 * Telemetry / transport regression coverage.
 *
 * Scope: verify that transport selection (foreground JSON mode vs background RPC
 * mode) and isolation flag emission are preserved across all configurations
 * reachable through the exported pure seams in index.ts:
 *   - buildForegroundToolArgs
 *   - buildBackgroundToolArgs
 *   - buildSystemPromptArgs
 *
 * These three helpers are the ONLY exported functions in index.ts. The actual
 * telemetry extraction (foreground usage/cost/token parsing of `message_end`
 * events) and background persistence (usage accumulation, appendEntry, saveOutput)
 * live in non-exported closures inside runSingleAgent / launchBackgroundAgent /
 * handleBgSignal / appendBgUsageEntry. Those closures can only be exercised by
 * spawning a real `pi` child process (network/model calls), which this test
 * suite must avoid. The missing seams are documented below as skipped tests with
 * precise reasons, so the gap is visible in test output rather than silently
 * absent.
 *
 * Importing index.ts does NOT trigger extension registration — the default
 * export (the extension entry point) is only invoked by pi when loading the
 * extension, never at module-eval time. So importing the pure helpers is safe
 * and side-effect free.
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildForegroundToolArgs,
	buildBackgroundToolArgs,
	buildSystemPromptArgs,
	buildIsolationArgs,
} from "./index.js";
import { loadAgentsFromDir, type AgentConfig } from "./agents.js";

const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
const PROMPT_PATH = "/tmp/PROMPT.md";

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
const BUNDLED_NAMES = ["scout", "planner", "reviewer", "executor"];

// ── Arg reconstruction ─────────────────────────────────────────────
//
// buildBgSpawnArgs is NOT exported, so we reconstruct the foreground and
// background spawn arg arrays from the exported helpers, mirroring the exact
// arg ordering used by index.ts::runSingleAgent and index.ts::buildBgSpawnArgs
// (plus the system-prompt args appended by launchBackgroundAgent). This is the
// same reconstruction strategy used by index-args.test.ts.

function foregroundArgs(agent: AgentConfig): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (agent.model) args.push("--model", agent.model);
	args.push(...buildForegroundToolArgs(agent.tools));
	// Mirror index.ts::runSingleAgent exactly: a prompt file is written when there
	// is a prompt body OR replace mode is set (replace still overrides Pi's default
	// prompt even with an empty body); otherwise individual isolation flags are
	// honored without a prompt flag.
	const hasPromptBody = agent.systemPrompt.trim().length > 0;
	const isReplace = agent.systemPromptMode === "replace";
	if (hasPromptBody || isReplace) {
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
		args.push(
			...buildIsolationArgs({
				noSkills: agent.noSkills,
				noPromptTemplates: agent.noPromptTemplates,
				noContextFiles: agent.noContextFiles,
			}),
		);
	}
	return args;
}

function backgroundArgs(agent: AgentConfig): string[] {
	const args: string[] = ["--mode", "rpc", "--no-session", "--no-extensions"];
	args.push("-e", "<bg-signal-ext>");
	if (agent.model) args.push("--model", agent.model);
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

// ── Transport mode selection ───────────────────────────────────────

describe("transport mode selection — foreground is JSON, background is RPC", () => {
	it("foreground reconstruction always uses --mode json exactly once and never rpc", () => {
		for (const name of BUNDLED_NAMES) {
			const args = foregroundArgs(BUNDLED[name]);
			expect(args.filter((a) => a === "--mode")).toHaveLength(1);
			expect(args).toContain("json");
			expect(args).not.toContain("rpc");
		}
	});

	it("background reconstruction always uses --mode rpc exactly once and never json", () => {
		for (const name of BUNDLED_NAMES) {
			const args = backgroundArgs(BUNDLED[name]);
			expect(args.filter((a) => a === "--mode")).toHaveLength(1);
			expect(args).toContain("rpc");
			expect(args).not.toContain("json");
		}
	});

	it("transport mode is the first two args in both modes (stable ordering)", () => {
		for (const name of BUNDLED_NAMES) {
			expect(foregroundArgs(BUNDLED[name]).slice(0, 2)).toEqual(["--mode", "json"]);
			expect(backgroundArgs(BUNDLED[name]).slice(0, 2)).toEqual(["--mode", "rpc"]);
		}
	});
});

// ── Isolation helpers do not alter transport selection ─────────────

describe("isolation helpers do not alter transport selection", () => {
	it("buildSystemPromptArgs never emits --mode, json, or rpc under any configuration", () => {
		const configs: Parameters<typeof buildSystemPromptArgs>[0][] = [
			{ systemPromptMode: undefined, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "append", promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "replace", promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "append", noSkills: true, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "append", noPromptTemplates: true, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "append", noContextFiles: true, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "append", noSkills: true, noPromptTemplates: true, noContextFiles: true, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "append", noSkills: false, noPromptTemplates: false, noContextFiles: false, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "replace", noSkills: true, noPromptTemplates: true, noContextFiles: true, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "replace", noSkills: false, noPromptTemplates: false, noContextFiles: false, promptFilePath: PROMPT_PATH },
			{ noSkills: true, promptFilePath: PROMPT_PATH },
			{ noSkills: true, noPromptTemplates: true, noContextFiles: true, promptFilePath: PROMPT_PATH },
		];
		for (const cfg of configs) {
			const out = buildSystemPromptArgs(cfg);
			expect(out).not.toContain("--mode");
			expect(out).not.toContain("json");
			expect(out).not.toContain("rpc");
		}
	});

	it("buildForegroundToolArgs never emits --mode, json, or rpc", () => {
		const inputs: (string[] | undefined)[] = [undefined, [], ["read"], ["read", "write", "bash"], ["__bg_signal"]];
		for (const tools of inputs) {
			const out = buildForegroundToolArgs(tools);
			expect(out).not.toContain("--mode");
			expect(out).not.toContain("json");
			expect(out).not.toContain("rpc");
		}
	});

	it("buildBackgroundToolArgs never emits --mode, json, or rpc", () => {
		const inputs: (string[] | undefined)[] = [undefined, [], ["read"], ["read", "write", "bash"], ["__bg_signal"], ["read", "__bg_signal"]];
		for (const tools of inputs) {
			const out = buildBackgroundToolArgs(tools);
			expect(out).not.toContain("--mode");
			expect(out).not.toContain("json");
			expect(out).not.toContain("rpc");
		}
	});

	it("replace-mode isolation flags do not change the foreground transport mode", () => {
		// Construct an agent config with replace mode + all isolation flags, then
		// verify the reconstructed foreground args still carry --mode json exactly once.
		const replaceAgent: AgentConfig = {
			...BUNDLED.executor,
			systemPromptMode: "replace",
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		};
		const args = foregroundArgs(replaceAgent);
		expect(args.filter((a) => a === "--mode")).toHaveLength(1);
		expect(args).toContain("json");
		expect(args).not.toContain("rpc");
		// And the isolation flags ARE present (proving they coexist with json, not replacing it)
		expect(args).toContain("--system-prompt");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-prompt-templates");
		expect(args).toContain("--no-context-files");
	});

	it("replace-mode isolation flags do not change the background transport mode", () => {
		const replaceAgent: AgentConfig = {
			...BUNDLED.executor,
			systemPromptMode: "replace",
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		};
		const args = backgroundArgs(replaceAgent);
		expect(args.filter((a) => a === "--mode")).toHaveLength(1);
		expect(args).toContain("rpc");
		expect(args).not.toContain("json");
		expect(args).toContain("--system-prompt");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-prompt-templates");
		expect(args).toContain("--no-context-files");
	});

	it("append-mode isolation flags do not change the transport mode (foreground or background)", () => {
		const appendAgent: AgentConfig = {
			...BUNDLED.executor,
			systemPromptMode: "append",
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		};
		const fg = foregroundArgs(appendAgent);
		const bg = backgroundArgs(appendAgent);
		expect(fg).toContain("json");
		expect(fg).not.toContain("rpc");
		expect(bg).toContain("rpc");
		expect(bg).not.toContain("json");
		// isolation flags present alongside append
		expect(fg).toContain("--append-system-prompt");
		expect(fg).toContain("--no-skills");
		expect(bg).toContain("--append-system-prompt");
		expect(bg).toContain("--no-skills");
	});

	it("default-mode (undefined) isolation does not add isolation flags and preserves transport", () => {
		// executor has no systemPromptMode set — append is the default
		const fg = foregroundArgs(BUNDLED.executor);
		const bg = backgroundArgs(BUNDLED.executor);
		expect(fg).toContain("json");
		expect(bg).toContain("rpc");
		expect(fg).not.toContain("--no-skills");
		expect(fg).not.toContain("--no-prompt-templates");
		expect(fg).not.toContain("--no-context-files");
		expect(bg).not.toContain("--no-skills");
	});
});

// ── __bg_signal is background-transport-only ───────────────────────

describe("__bg_signal tool is background-transport-only", () => {
	it("foreground tool args never include __bg_signal", () => {
		expect(buildForegroundToolArgs(undefined)).not.toContain("__bg_signal");
		expect(buildForegroundToolArgs([])).not.toContain("__bg_signal");
		expect(buildForegroundToolArgs(["read", "write"])).not.toContain("__bg_signal");
		// Even if a caller explicitly lists it, foreground does not strip it, but
		// the bundled agents never request it and foreground helpers never ADD it.
		for (const name of BUNDLED_NAMES) {
			expect(foregroundArgs(BUNDLED[name])).not.toContain("__bg_signal");
		}
	});

	it("background tool args preserve __bg_signal in every non-undefined case", () => {
		// undefined => no flag (extension-loaded __bg_signal survives via -e)
		expect(buildBackgroundToolArgs(undefined)).toEqual([]);
		// [] => --tools __bg_signal keeps only the lifecycle tool active
		expect(buildBackgroundToolArgs([])).toEqual(["--tools", "__bg_signal"]);
		// non-empty => __bg_signal appended (no duplicate)
		expect(buildBackgroundToolArgs(["read"])).toEqual(["--tools", "read,__bg_signal"]);
		expect(buildBackgroundToolArgs(["read", "__bg_signal"])).toEqual(["--tools", "read,__bg_signal"]);
	});

	it("background reconstruction for bundled agents with tools always has __bg_signal in the --tools list", () => {
		for (const name of ["scout", "planner", "reviewer"]) {
			const args = backgroundArgs(BUNDLED[name]);
			const toolsIdx = args.indexOf("--tools");
			expect(toolsIdx).toBeGreaterThan(-1);
			const toolsList = args[toolsIdx + 1];
			expect(toolsList).toContain("__bg_signal");
		}
	});

	it("background reconstruction for executor (tools omitted) relies on extension, no --tools flag", () => {
		const args = backgroundArgs(BUNDLED.executor);
		expect(args).not.toContain("--tools");
		expect(args).toContain("-e");
		expect(args).toContain("<bg-signal-ext>");
	});

	it("foreground --no-tools (empty tools) disables ALL tools; background --tools __bg_signal keeps the lifecycle tool", () => {
		// This is the transport-isolation invariant: background must never use --no-tools
		// because it would kill __bg_signal (the RPC completion signal channel). Instead
		// it allowlists only __bg_signal via --tools, disabling every task tool while
		// keeping the lifecycle signal active.
		expect(buildForegroundToolArgs([])).toEqual(["--no-tools"]);
		expect(buildBackgroundToolArgs([])).toEqual(["--tools", "__bg_signal"]);
		expect(buildBackgroundToolArgs([])).not.toContain("--no-tools");
	});
});

// ── Transport-relevant flag isolation summary ──────────────────────

describe("no transport flag leaks into tool/system-prompt helper output", () => {
	it("the union of all helper outputs across all configs contains no transport flags", () => {
		const transportFlags = ["--mode", "json", "rpc", "-p", "--no-session", "--no-extensions"];
		const allOutputs: string[] = [];

		for (const tools of [undefined, [], ["read"], ["read", "bash"]] as (string[] | undefined)[]) {
			allOutputs.push(...buildForegroundToolArgs(tools));
			allOutputs.push(...buildBackgroundToolArgs(tools));
		}

		const spConfigs: Parameters<typeof buildSystemPromptArgs>[0][] = [
			{ systemPromptMode: undefined, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "append", promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "replace", promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "append", noSkills: true, noPromptTemplates: true, noContextFiles: true, promptFilePath: PROMPT_PATH },
			{ systemPromptMode: "replace", noSkills: true, noPromptTemplates: true, noContextFiles: true, promptFilePath: PROMPT_PATH },
		];
		for (const cfg of spConfigs) {
			allOutputs.push(...buildSystemPromptArgs(cfg));
		}

		for (const flag of transportFlags) {
			expect(allOutputs).not.toContain(flag);
		}
	});
});

// ── Missing seams: telemetry extraction & persistence ──────────────
//
// The following tests are SKIPPED because the logic they should cover is not
// reachable through any exported, pure seam. Each skip reason names the exact
// non-exported function/closure and why it cannot be tested without spawning a
// real `pi` child process (network/model calls) or mutating production code.
//
// Per the task constraints ("Do NOT delete or modify production files",
// "Avoid network/model calls"), these are reported as missing seams rather than
// worked around.

describe.skip("foreground usage/cost/token extraction — MISSING SEAM", () => {
	// The extraction logic lives in the `processLine` closure inside
	// runSingleAgent (index.ts ~lines 744-770). It parses `message_end` events
	// and accumulates:
	//   usage.input      += msg.usage.input
	//   usage.output     += msg.usage.output
	//   usage.cacheRead  += msg.usage.cacheRead
	//   usage.cacheWrite += msg.usage.cacheWrite
	//   usage.cost       += msg.usage.cost?.total
	//   usage.contextTokens = msg.usage.totalTokens   (overwrite, not accumulate)
	//   usage.turns++
	//   model/provider/stopReason/errorMessage capture
	//
	// runSingleAgent is not exported. processLine is a closure, not a function
	// reference. The only way to exercise it is to call runSingleAgent, which
	// spawns `pi` (network/model). No pure seam exists.

	it("should preserve accumulation of input/output/cacheRead/cacheWrite across multiple message_end events");
	it("should preserve cost extraction from usage.cost.total (not usage.cost directly)");
	it("should preserve contextTokens overwrite (not accumulate) from usage.totalTokens");
	it("should preserve turns increment per assistant message_end");
	it("should preserve first-model-wins capture (does not overwrite if already set)");
	it("should preserve stopReason/errorMessage capture on assistant messages");
});

describe.skip("background usage/cost accumulation — MISSING SEAM", () => {
	// The background accumulation logic lives in the `processLine` closure
	// inside launchBackgroundAgent (index.ts ~lines 990-1040). It mirrors the
	// foreground extraction (same fields, same cost?.total / totalTokens
	// semantics) but also handles __bg_signal tool-call detection and implicit
	// done on endTurn-with-no-pending-tools. launchBackgroundAgent is not
	// exported; processLine is a closure. Requires spawning `pi` (RPC mode).

	it("should preserve accumulation of usage fields across background message_end events");
	it("should preserve cost extraction from usage.cost.total in background mode");
	it("should preserve contextTokens overwrite from usage.totalTokens in background mode");
	it("should preserve __bg_signal detection from both tool_call events and message_end content parts");
	it("should preserve implicit-done on endTurn with no pending non-bg-signal tool calls");
});

describe.skip("background result persistence — MISSING SEAM", () => {
	// Persistence is handled by:
	//   - appendBgUsageEntry (index.ts ~line 1618): calls piRef?.appendEntry(
	//       "subagent-bg-usage", { id, agent, status, usage, model, provider,
	//       elapsedMs }). Not exported; requires a live piRef.
	//   - handleBgSignal (index.ts ~line 1103): on done, calls saveOutput(
	//       teamName, saveAs, output) and sets result.savedAs. Not exported.
	//   - checkParallelGroupCompletion / advanceChain: aggregate member usage
	//     into totalUsage and call piRef?.appendEntry with group-level entry.
	//     Not exported.
	// All require a live piRef (ExtensionAPI) and/or a spawned background
	// process. No pure seam exists.

	it("should preserve appendBgUsageEntry entry shape { id, agent, status, usage, model, provider, elapsedMs }");
	it("should preserve saveOutput call on done when teamName and saveAs are set");
	it("should preserve result.savedAs assignment after saveOutput");
	it("should preserve group-level usage aggregation (sum of member usage) in parallel completion");
	it("should preserve group-level usage aggregation in chain completion");
	it("should preserve group entry shape { id, type, mode, status, members/steps, usage, elapsedMs }");
});

describe.skip("getFinalOutput / formatUsageStats / parseModelString — MISSING SEAM (pure but not exported)", () => {
	// These are pure functions (no spawn, no piRef) but are NOT exported:
	//   - getFinalOutput(messages: Message[]): string  — extracts last assistant text
	//   - formatUsageStats(usage, model?, opts?): string  — formats tokens/cost/context
	//   - parseModelString(modelStr): { provider, model, reasoning }
	//   - getContextWindow(model): number | null
	//   - formatTokens(count): string
	//   - formatDuration(ms): string
	// They could be unit-tested if exported, but exporting them would modify
	// production code, which the task forbids.

	it("getFinalOutput returns last assistant text part");
	it("getFinalOutput returns empty string when no assistant messages");
	it("formatUsageStats single-agent format includes tokens, cost, context %");
	it("formatUsageStats aggregate format includes turns, tokens, cost, elapsed");
	it("parseModelString extracts provider/model/reasoning from 'provider/model:level'");
	it("getContextWindow returns known context sizes and null for unknown models");
});
