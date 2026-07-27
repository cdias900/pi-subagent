/**
 * Background routing & signal regressions.
 *
 * These tests guard the invariants that keep background subagent children able
 * to call __bg_signal:
 *
 *  1. Background tools:[]  => --tools __bg_signal (only the lifecycle tool; no task tools)
 *     Foreground tools:[] => --no-tools        (all tools off — no extension needed)
 *  2. Nonempty background allowlists always preserve __bg_signal.
 *  3. Omitted tools preserve the legacy no-flag behavior for both modes.
 *  4. Every background spawn route (single, parallel, chain, advanceChain/team)
 *     uses the SAME helper — buildBgSpawnArgs — rather than each assembling its
 *     own args. This is verified by static source inspection of the wiring, NOT
 *     by copying/reconstructing the implementation, so a route that bypasses the
 *     helper is caught without making the test brittle to arg ordering.
 *  5. The bg-signal extension flag (-e BG_SIGNAL_EXT_PATH) and the BG_SIGNAL
 *     system-prompt instruction remain wired into the background spawn path,
 *     and bg-signal.ts registers a tool literally named "__bg_signal".
 *
 * No production files are modified. No network-dependent permanent test is
 * added — the manual CLI smoke is run out-of-band and not committed.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildForegroundToolArgs,
	buildBackgroundToolArgs,
} from "./index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_SRC = fs.readFileSync(path.join(__dirname, "index.ts"), "utf-8");
const BG_SIGNAL_SRC = fs.readFileSync(path.join(__dirname, "bg-signal.ts"), "utf-8");

// ── 1. Empty allowlist: --tools __bg_signal (bg) vs --no-tools (fg) ───────

describe("background empty tools => --tools __bg_signal; foreground empty => --no-tools", () => {
	it("background tools:[] produces --tools __bg_signal, never --no-tools", () => {
		const bg = buildBackgroundToolArgs([]);
		expect(bg).toEqual(["--tools", "__bg_signal"]);
		expect(bg).not.toContain("--no-tools");
	});

	it("foreground tools:[] produces --no-tools, never --tools __bg_signal", () => {
		const fg = buildForegroundToolArgs([]);
		expect(fg).toEqual(["--no-tools"]);
		expect(fg).not.toContain("--tools");
	});

	it("the two empty-allowlist results are distinct (divergent semantics preserved)", () => {
		expect(buildBackgroundToolArgs([])).not.toEqual(buildForegroundToolArgs([]));
	});
});

// ── 2. Nonempty allowlists preserve __bg_signal ───────────────────────────

describe("nonempty background allowlists preserve __bg_signal", () => {
	it("appends __bg_signal to a plain allowlist", () => {
		expect(buildBackgroundToolArgs(["read", "write"])).toEqual([
			"--tools",
			"read,write,__bg_signal",
		]);
	});

	it("does not duplicate __bg_signal when already present", () => {
		expect(buildBackgroundToolArgs(["read", "__bg_signal"])).toEqual([
			"--tools",
			"read,__bg_signal",
		]);
	});

	it("preserves __bg_signal for a single-tool allowlist", () => {
		expect(buildBackgroundToolArgs(["read"])).toEqual(["--tools", "read,__bg_signal"]);
	});

	it("the tools list value always contains __bg_signal for nonempty input", () => {
		const args = buildBackgroundToolArgs(["bash", "edit", "grep"]);
		const listIdx = args.indexOf("--tools");
		expect(listIdx).toBeGreaterThan(-1);
		expect(args[listIdx + 1].split(",")).toContain("__bg_signal");
	});

	it("foreground never injects __bg_signal", () => {
		const fg = buildForegroundToolArgs(["read", "write"]);
		expect(fg).toEqual(["--tools", "read,write"]);
		expect(fg.join(",")).not.toContain("__bg_signal");
	});
});

// ── 3. Omitted tools preserve legacy behavior ─────────────────────────────

describe("omitted tools => no flag (legacy behavior)", () => {
	it("background omitted => [] (no tool flag; __bg_signal arrives via extension)", () => {
		expect(buildBackgroundToolArgs(undefined)).toEqual([]);
	});

	it("foreground omitted => [] (inherit child defaults)", () => {
		expect(buildForegroundToolArgs(undefined)).toEqual([]);
	});

	it("omitted is distinct from empty for both modes", () => {
		expect(buildBackgroundToolArgs(undefined)).not.toEqual(buildBackgroundToolArgs([]));
		expect(buildForegroundToolArgs(undefined)).not.toEqual(buildForegroundToolArgs([]));
	});
});

// ── 4. All background routes share buildBgSpawnArgs ───────────────────────
//
// We assert via static source inspection that every background spawn site calls
// buildBgSpawnArgs, rather than reconstructing arg arrays. This catches a route
// bypassing the shared helper (and thus losing __bg_signal wiring) without
// duplicating the implementation or pinning to exact arg ordering.

describe("all background spawn routes use the shared buildBgSpawnArgs helper", () => {
	it("index.ts defines buildBgSpawnArgs", () => {
		expect(INDEX_SRC).toMatch(/function buildBgSpawnArgs\s*\(/);
	});

	it("buildBgSpawnArgs delegates tool flags to buildBackgroundToolArgs", () => {
		// The helper must call the exported pure seam — not inline its own flag logic.
		const helperBody = extractFunctionBody(INDEX_SRC, "buildBgSpawnArgs");
		expect(helperBody).toBeTruthy();
		expect(helperBody).toContain("buildBackgroundToolArgs");
	});

	it("buildBgSpawnArgs delegates resolved model flags to buildModelArgs", () => {
		const helperBody = extractFunctionBody(INDEX_SRC, "buildBgSpawnArgs");
		expect(helperBody).toContain("buildModelArgs(resolved)");
		expect(helperBody).not.toContain("agentConfig.model");
	});

	it("buildBgSpawnArgs keeps model flags after extensions and before tool flags", () => {
		const helperBody = extractFunctionBody(INDEX_SRC, "buildBgSpawnArgs");
		const extensionIdx = helperBody.lastIndexOf('args.push("-e"');
		const modelIdx = helperBody.indexOf("buildModelArgs(resolved)");
		const toolsIdx = helperBody.indexOf("buildBackgroundToolArgs");
		expect(extensionIdx).toBeGreaterThanOrEqual(0);
		expect(extensionIdx).toBeLessThan(modelIdx);
		expect(modelIdx).toBeLessThan(toolsIdx);
	});

	it("buildBgSpawnArgs loads the bg-signal extension (-e BG_SIGNAL_EXT_PATH)", () => {
		const helperBody = extractFunctionBody(INDEX_SRC, "buildBgSpawnArgs");
		expect(helperBody).toContain("-e");
		expect(helperBody).toContain("BG_SIGNAL_EXT_PATH");
	});

	it("single background path calls buildBgSpawnArgs with its resolved model", () => {
		// The single-agent background branch passes invocation.agent as the first arg,
		// distinguishing it from the parallel/chain call shape (agentConfig, ...).
		const calls = INDEX_SRC.match(
			/buildBgSpawnArgs\(invocation\.agent, invocation\.resolvedModel,/g,
		) ?? [];
		expect(calls).toHaveLength(1);
	});

	it("parallel + chain background paths pass invocation.resolvedModel to buildBgSpawnArgs", () => {
		// Both launchBackgroundParallel and launchBackgroundChain share this exact call shape.
		const calls = INDEX_SRC.match(
			/buildBgSpawnArgs\(agentConfig, invocation\.resolvedModel, invocation\.mcps, invocation\.extensions, teamName\)/g,
		);
		expect(calls && calls.length).toBeGreaterThanOrEqual(2);
	});

	it("advanceChain passes the stored resolved model to buildBgSpawnArgs", () => {
		expect(INDEX_SRC).toMatch(
			/buildBgSpawnArgs\(agentConfig, stepDef\.resolvedModel, stepDef\.mcps, stepDef\.extensions, group\.teamName\)/,
		);
	});

	it("advanceChain reuses its preflight-resolved model without rebuilding or revalidating it", () => {
		const body = extractFunctionBody(INDEX_SRC, "advanceChain");
		expect(body).toContain("resolvedModel: stepDef.resolvedModel");
		for (const forbidden of [
			"resolveModelLayers",
			"buildModelResolution",
			"validateResolvedModel",
		]) {
			expect(body).not.toContain(forbidden);
		}
	});

	it("launchBackgroundParallel and launchBackgroundChain each funnel buildBgSpawnArgs to launchBackgroundAgent", () => {
		// Both routes share the exact buildBgSpawnArgs call shape. Every occurrence
		// of that shape must be followed by a launchBackgroundAgent call within the
		// same route block (bounded window), so neither route can silently bypass
		// the shared spawn helper.
		const shape = /buildBgSpawnArgs\(agentConfig, invocation\.resolvedModel, invocation\.mcps, invocation\.extensions, teamName\)/g;
		const occurrences: RegExpExecArray[] = [];
		let m: RegExpExecArray | null;
		while ((m = shape.exec(INDEX_SRC)) !== null) occurrences.push(m);
		expect(occurrences.length).toBeGreaterThanOrEqual(2);
		for (const occ of occurrences) {
			const window = INDEX_SRC.slice(occ.index, occ.index + 3000);
			expect(window).toContain("launchBackgroundAgent(");
		}
	});

	it("advanceChain (team/chain continuation) builds args via buildBgSpawnArgs and spawns via launchBackgroundAgent", () => {
		assertRouteFunnel(INDEX_SRC, /buildBgSpawnArgs\(agentConfig, stepDef\.resolvedModel, stepDef\.mcps, stepDef\.extensions, group\.teamName\)/);
	});

	it("the single-agent background branch builds args via buildBgSpawnArgs and spawns via launchBackgroundAgent", () => {
		// The single-agent background path lives in the default-export handler and
		// is identified by its distinctive resolved-model call shape.
		assertRouteFunnel(INDEX_SRC, /buildBgSpawnArgs\(invocation\.agent, invocation\.resolvedModel,/);
	});

	it("trySpawnQueued drains the queue through launchBackgroundAgent", () => {
		const body = extractFunctionBody(INDEX_SRC, "trySpawnQueued");
		expect(body).toBeTruthy();
		expect(body).toContain("launchBackgroundAgent(");
	});

	it("buildBgSpawnArgs is called from at least one site per background route (stable minimum invariant)", () => {
		// One definition + at least four route call sites (single, parallel, chain,
		// advanceChain). A minimum (not exact) count avoids brittleness to benign
		// refactors while still failing if a route drops the shared helper entirely.
		const calls = INDEX_SRC.match(/buildBgSpawnArgs\s*\(/g) || [];
		expect(calls.length).toBeGreaterThanOrEqual(5);
	});
});

// ── 5. BG_SIGNAL prompt + extension flags remain wired ────────────────────

describe("BG_SIGNAL prompt/extension flags remain wired", () => {
	it("BG_SIGNAL_EXT_PATH resolves to the bundled bg-signal.ts", () => {
		expect(INDEX_SRC).toMatch(/const BG_SIGNAL_EXT_PATH\s*=/);
		expect(INDEX_SRC).toMatch(/BG_SIGNAL_EXT_PATH.*bg-signal\.ts/);
		const resolved = path.resolve(__dirname, "bg-signal.ts");
		expect(fs.existsSync(resolved)).toBe(true);
	});

	it("BG_SIGNAL_INSTRUCTION is defined and references __bg_signal", () => {
		expect(INDEX_SRC).toMatch(/const BG_SIGNAL_INSTRUCTION\s*=/);
		const body = extractConstString(INDEX_SRC, "BG_SIGNAL_INSTRUCTION");
		expect(body).toContain("__bg_signal");
		expect(body).toMatch(/done/);
	});

	it("launchBackgroundAgent appends BG_SIGNAL_INSTRUCTION to the system prompt", () => {
		const launchBody = extractFunctionBody(INDEX_SRC, "launchBackgroundAgent");
		expect(launchBody).toContain("BG_SIGNAL_INSTRUCTION");
		expect(launchBody).toContain("buildSystemPromptArgs");
	});

	it("bg-signal.ts registers a tool named __bg_signal", () => {
		expect(BG_SIGNAL_SRC).toMatch(/name:\s*["']__bg_signal["']/);
	});

	it("bg-signal.ts is a default-export extension using registerTool", () => {
		expect(BG_SIGNAL_SRC).toMatch(/export default function/);
		expect(BG_SIGNAL_SRC).toMatch(/registerTool/);
	});
});

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Assert that a background route both calls buildBgSpawnArgs (via its distinctive
 * call shape) and then funnels to launchBackgroundAgent within the same route
 * block. Uses a bounded character window after the buildBgSpawnArgs call rather
 * than an exact total source-occurrence count, so benign refactors or comments
 * elsewhere do not break the test, but a route that drops the shared helper or
 * stops funnelling through launchBackgroundAgent is still caught.
 */
function assertRouteFunnel(src: string, callShape: RegExp): void {
	const match = callShape.exec(src);
	expect(match).not.toBeNull();
	const callIdx = match!.index!;
	// Each route constructs its bgAgent then calls launchBackgroundAgent within
	// ~1.5k chars of the buildBgSpawnArgs call; 3k is a safe bounded window.
	const window = src.slice(callIdx, callIdx + 3000);
	expect(window).toContain("launchBackgroundAgent(");
}

/**
 * Extract the body of a top-level `function name(` declaration from source text.
 * Returns the source between the opening brace and the matching closing brace.
 */
function extractFunctionBody(src: string, fnName: string): string {
	const decl = new RegExp("function\\s+" + fnName + "\\s*\\(");
	const match = decl.exec(src);
	if (!match) return "";
	const openBrace = src.indexOf("{", match.index);
	if (openBrace === -1) return "";
	let depth = 0;
	for (let i = openBrace; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return src.slice(openBrace + 1, i);
		}
	}
	return "";
}

/**
 * Extract the string literal assigned to a const declaration using
 * backtick, single, or double quotes. Returns the raw text inside the quotes.
 */
function extractConstString(src: string, constName: string): string {
	// Build the regex from a plain string to avoid backtick-in-template pitfalls.
	const pattern = "const\\s+" + constName + "\\s*=\\s*([`'\"])";
	const match = new RegExp(pattern).exec(src);
	if (!match) return "";
	const quote = match[1];
	const start = match.index + match[0].length;
	const end = src.indexOf(quote, start);
	return end === -1 ? "" : src.slice(start, end);
}
