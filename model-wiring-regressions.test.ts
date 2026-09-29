import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_SRC = fs.readFileSync(path.join(__dirname, "index.ts"), "utf8");
const AGENT_MODEL_COMMAND_SRC = fs.readFileSync(
	path.join(__dirname, "agent-model-command.ts"),
	"utf8",
);

const CANONICAL_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function between(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
	expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
	return source.slice(start, end);
}

function extractCalls(source: string, callee: string): string[] {
	const calls: string[] = [];
	const marker = `${callee}(`;
	let searchFrom = 0;

	while (true) {
		const start = source.indexOf(marker, searchFrom);
		if (start === -1) return calls;

		const openParen = start + callee.length;
		let depth = 0;
		let quote: "\"" | "'" | "`" | undefined;
		let escaped = false;
		let lineComment = false;
		let blockComment = false;

		for (let index = openParen; index < source.length; index++) {
			const char = source[index];
			const next = source[index + 1];

			if (lineComment) {
				if (char === "\n") lineComment = false;
				continue;
			}
			if (blockComment) {
				if (char === "*" && next === "/") {
					blockComment = false;
					index++;
				}
				continue;
			}
			if (quote !== undefined) {
				if (escaped) {
					escaped = false;
				} else if (char === "\\") {
					escaped = true;
				} else if (char === quote) {
					quote = undefined;
				}
				continue;
			}
			if (char === "/" && next === "/") {
				lineComment = true;
				index++;
				continue;
			}
			if (char === "/" && next === "*") {
				blockComment = true;
				index++;
				continue;
			}
			if (char === "\"" || char === "'" || char === "`") {
				quote = char;
				continue;
			}
			if (char === "(") depth++;
			if (char === ")") {
				depth--;
				if (depth === 0) {
					calls.push(source.slice(start, index + 1));
					searchFrom = index + 1;
					break;
				}
			}
		}

		if (searchFrom <= start) return calls;
	}
}

const SUBAGENT_EXECUTE = between(
	INDEX_SRC,
	"async execute(_toolCallId, params, signal, onUpdate, ctx)",
	"\n\t\trenderCall(args, theme)",
);

function expectOnePreflightBefore(
	source: string,
	...laterMarkers: string[]
): string {
	const calls = extractCalls(source, "preflightValidateInvocations");
	expect(calls).toHaveLength(1);
	const preflightIndex = source.indexOf(calls[0]);
	for (const marker of laterMarkers) {
		const markerIndex = source.indexOf(marker);
		expect(markerIndex, `missing later marker: ${marker}`).toBeGreaterThanOrEqual(0);
		expect(preflightIndex, `preflight must precede: ${marker}`).toBeLessThan(
			markerIndex,
		);
	}
	return calls[0];
}

describe("subagent model selection schemas", () => {
	it("keeps the canonical thinking-level enum used by configurable invocation schemas", () => {
		const thinkingSchema = between(
			INDEX_SRC,
			"const SubagentThinkingLevelSchema",
			"function invocationModelOverrideProperties",
		);
		const enumValues = /StringEnum\(\s*\[([\s\S]*?)\]\s*as const/.exec(
			thinkingSchema,
		)?.[1];
		expect(enumValues).toBeDefined();
		expect(
			[...enumValues!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]),
		).toEqual(CANONICAL_THINKING_LEVELS);
	});

	it("keeps invocation-wide and per-item values in separate resolution layers", () => {
		expect(SUBAGENT_EXECUTE).toMatch(
			/const invocationModelOverride:\s*AgentModelOverride\s*=\s*\{[\s\S]*?model:\s*params\.model,[\s\S]*?thinkingLevel:\s*params\.thinkingLevel/,
		);

		const foregroundParallel = between(
			SUBAGENT_EXECUTE,
			"if (params.tasks && params.tasks.length > 0)",
			"if (params.agent &&",
		);
		const parallelCall = extractCalls(foregroundParallel, "resolveInvocation")[0];
		expect(parallelCall).toContain("spec: { ...t,");
		expect(parallelCall).toContain("modelResolution: modelResolutionFor(t.agent)");

		const singleBlock = between(SUBAGENT_EXECUTE, "if (params.agent &&", "const available =");
		const singleCall = extractCalls(singleBlock, "resolveInvocation")[0];
		expect(singleCall).toContain("modelResolution: modelResolutionFor(params.agent)");
		const singleSpec = between(singleCall, "spec: {", "modelResolution:");
		expect(singleSpec).not.toMatch(/\bmodel:\s*params\.model/);
		expect(singleSpec).not.toMatch(/\bthinkingLevel:\s*params\.thinkingLevel/);
	});
});

describe("foreground model resolution wiring", () => {
	it("assembles invocation, session, global, and parent layers from one loaded config", () => {
		const helper = between(INDEX_SRC, "function buildModelResolution", "interface ChainStepDef");
		const assembledLayers = between(helper, "return {", "\n\t};");
		expect(assembledLayers).toMatch(/\binvocation(?:\s*:\s*invocation)?\s*,/);
		expect(assembledLayers).toMatch(/session:\s*sessionModelOverrides\[agentName\]/);
		expect(assembledLayers).toMatch(/global:\s*globalOverride/);
		expect(assembledLayers).toMatch(/\bparent(?:\s*:\s*parent)?\s*,/);

		expect((SUBAGENT_EXECUTE.match(/loadGlobalConfig\(\)/g) ?? []).length).toBe(1);
		expect(SUBAGENT_EXECUTE).toMatch(
			/const\s*\{\s*config:\s*globalModelConfig,\s*error:\s*globalModelConfigError,?\s*\}\s*=\s*loadGlobalConfig\(\)/,
		);
		expect(SUBAGENT_EXECUTE).not.toContain("loadGlobalConfig().config");
		expect(SUBAGENT_EXECUTE).toMatch(
			/if\s*\(globalModelConfigError\s*!==\s*undefined\)\s*throw new Error\(formatGlobalConfigDispatchError\(globalModelConfigError\)\)/,
		);
		const configErrorGuard = SUBAGENT_EXECUTE.indexOf(
			"if (globalModelConfigError !== undefined)",
		);
		expect(configErrorGuard).toBeGreaterThanOrEqual(0);
		expect(configErrorGuard).toBeLessThan(
			SUBAGENT_EXECUTE.indexOf("resolveInvocation("),
		);
		const parentHelper = between(
			INDEX_SRC,
			"function parentModelForContext",
			"export function buildEffectiveConfig",
		);
		expect(
			(SUBAGENT_EXECUTE.match(/parentModelForContext\(ctx\)/g) ?? []).length,
		).toBe(1);
		expect(parentHelper).toMatch(/ctx\.model\.provider[\s\S]*ctx\.model\.id/);
		expect(INDEX_SRC).toMatch(
			/import\s*\{[^}]*\bisThinkingLevel\b[^}]*\}\s*from\s*["']\.\/model-normalize\.js["']/s,
		);
		expect(parentHelper).toContain(
			"const parentThinkingLevel = piRef?.getThinkingLevel();",
		);
		expect(parentHelper).toMatch(
			/thinkingLevel:\s*parentThinkingLevel\s*!==\s*undefined\s*&&\s*isThinkingLevel\(parentThinkingLevel\)\s*\?\s*parentThinkingLevel\s*:\s*undefined/,
		);
		expect(parentHelper).not.toMatch(
			/piRef\?\.getThinkingLevel\(\)\s+as\s+SubagentThinkingLevel/,
		);
	});

	it("passes modelResolution to foreground chain preflight and execution", () => {
		const foregroundChain = between(
			SUBAGENT_EXECUTE,
			"if (params.chain && params.chain.length > 0)",
			"if (params.tasks && params.tasks.length > 0)",
		);
		const calls = extractCalls(foregroundChain, "resolveInvocation");
		expect(calls.some((call) => call.includes("isPreflight: true"))).toBe(true);
		expect(calls.some((call) => call.includes("step: i + 1"))).toBe(true);
		expect(calls.every((call) => call.includes("modelResolution:"))).toBe(true);
	});

	it("passes modelResolution to foreground parallel and single execution", () => {
		const foregroundParallel = between(
			SUBAGENT_EXECUTE,
			"if (params.tasks && params.tasks.length > 0)",
			"if (params.agent &&",
		);
		const singleBlock = between(SUBAGENT_EXECUTE, "if (params.agent &&", "const available =");
		for (const block of [foregroundParallel, singleBlock]) {
			const calls = extractCalls(block, "resolveInvocation");
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.every((call) => call.includes("modelResolution:"))).toBe(true);
		}
	});
});

describe("resolved model SDK wiring", () => {
	it("constructs the child with its resolved model before prompting", () => {
		const runBody = between(
			INDEX_SRC,
			"async function runSingleAgent(",
			"// ── Background agent helpers",
		);
		const modelIdx = runBody.indexOf("resolvedModel: invocation.resolvedModel");
		const taskPromptIdx = runBody.indexOf("await child.prompt(invocation.prompt)");
		expect(modelIdx).toBeGreaterThanOrEqual(0);
		expect(modelIdx).toBeLessThan(taskPromptIdx);
	});

	it("keeps requested model provenance separate from the SDK's actual model", () => {
		const runBody = between(
			INDEX_SRC,
			"async function runSingleAgent(",
			"// ── Background agent helpers",
		);
		expect(runBody).toContain("buildResolvedModelMetadata(invocation.resolvedModel)");
		expect(runBody).toContain("currentResult.model ||= child.session.model?.id");
	});

	it("removes raw frontmatter-model pushes from child spawn assembly", () => {
		expect(INDEX_SRC).not.toMatch(
			/if\s*\(\s*(?:agent|agentConfig)\.model\s*\)\s*args\.push\(\s*["']--model["']/,
		);
	});
});

describe("eager model registry preflight wiring", () => {
	it("validates exactly once per mode before any launch or run path", () => {
		expect(
			(SUBAGENT_EXECUTE.match(/preflightValidateInvocations\s*\(/g) ?? [])
				.length,
		).toBe(5);

		const backgroundParallel = between(
			SUBAGENT_EXECUTE,
			"// ── V2: Background parallel",
			"// ── V2: Background chain",
		);
		expectOnePreflightBefore(
			backgroundParallel,
			"launchBackgroundParallel(",
		);

		const backgroundChain = between(
			SUBAGENT_EXECUTE,
			"// ── V2: Background chain",
			"if (params.chain && params.chain.length > 0)",
		);
		const backgroundChainCall = expectOnePreflightBefore(
			backgroundChain,
			"const firstInvocation",
			"launchBackgroundChain(",
		);
		expect(backgroundChainCall).toContain("preflightInvocations");

		const foregroundChain = between(
			SUBAGENT_EXECUTE,
			"if (params.chain && params.chain.length > 0)",
			"if (params.tasks && params.tasks.length > 0)",
		);
		const foregroundChainCall = expectOnePreflightBefore(
			foregroundChain,
			"runSingleAgent(",
		);
		expect(foregroundChainCall).toContain("preflightInvocations");

		const foregroundParallel = between(
			SUBAGENT_EXECUTE,
			"if (params.tasks && params.tasks.length > 0)",
			"if (params.agent &&",
		);
		const foregroundParallelCall = expectOnePreflightBefore(
			foregroundParallel,
			"mapWithConcurrencyLimit(",
		);
		expect(foregroundParallelCall).toContain("invocations");

		const single = between(
			SUBAGENT_EXECUTE,
			"if (params.agent &&",
			"const available =",
		);
		const singleCall = expectOnePreflightBefore(
			single,
			"launchBackgroundAgent(",
			"runSingleAgent(",
		);
		expect(singleCall).toContain("[invocation]");
	});
});

describe("agent model command wiring", () => {
	it("registers /agent-model from the extension entrypoint", () => {
		expect(INDEX_SRC).toMatch(
			/import\s*\{\s*registerAgentModelCommand\s*\}\s*from\s*["']\.\/agent-model-command\.js["']/,
		);
		expect(INDEX_SRC).toContain("registerAgentModelCommand(pi, {");
	});

	it("gates guided rendering through a structural live-mode helper", () => {
		expect(AGENT_MODEL_COMMAND_SRC).toMatch(
			/function getExtensionMode\([\s\S]*?mode\?: unknown[\s\S]*?["']tui["'][\s\S]*?["']rpc["'][\s\S]*?["']json["'][\s\S]*?["']print["']/,
		);
		expect(AGENT_MODEL_COMMAND_SRC).toMatch(
			/getExtensionMode\(ctx\)\s*!==\s*["']tui["']/,
		);
	});

	it("builds the model picker with a Container and an explicit five-callback SelectListTheme", () => {
		expect(AGENT_MODEL_COMMAND_SRC).toContain("new Container()");
		// The theme is extracted to a single typed const rather than inlined
		// twice. This still fails if someone drops any of the five callbacks or
		// stops passing the theme to SelectList: the const must define all five,
		// and every `new SelectList(...)` must pass `listTheme` (not an inline
		// object literal).
		expect(AGENT_MODEL_COMMAND_SRC).toMatch(
			/const\s+listTheme:\s*SelectListTheme\s*=\s*\{[\s\S]*?selectedPrefix:\s*\([^)]*\)\s*=>\s*theme\.fg\(["']accent["'][\s\S]*?selectedText:\s*\([^)]*\)\s*=>\s*theme\.fg\(["']accent["'][\s\S]*?description:\s*\([^)]*\)\s*=>\s*theme\.fg\(["']muted["'][\s\S]*?scrollInfo:\s*\([^)]*\)\s*=>\s*theme\.fg\(["']dim["'][\s\S]*?noMatch:\s*\([^)]*\)\s*=>\s*theme\.fg\(["']warning["'][\s\S]*?\};/,
		);
		// Every SelectList construction must pass the shared theme const — no
		// inline object literal may sneak back in.
		const selectListCalls = extractCalls(
			AGENT_MODEL_COMMAND_SRC,
			"new SelectList",
		);
		expect(selectListCalls.length).toBeGreaterThanOrEqual(1);
		for (const call of selectListCalls) {
			expect(call).toContain(", listTheme)");
			expect(call).not.toMatch(/,\s*\{[\s\S]*selectedPrefix:/);
		}
		expect(AGENT_MODEL_COMMAND_SRC).toMatch(
			/\.onSelect\s*=\s*\([^)]*\)\s*=>\s*done\(/,
		);
		expect(AGENT_MODEL_COMMAND_SRC).toMatch(
			/\.onCancel\s*=\s*\(\)\s*=>\s*done\(undefined\)/,
		);
	});

	it("appends a complete session snapshot before publishing the new in-memory map", () => {
		const registration = between(
			INDEX_SRC,
			"registerAgentModelCommand(pi, {",
			"\n\t});",
		);
		const computeIndex = registration.indexOf("computeUpdatedOverrides(");
		const appendIndex = registration.indexOf("appendSessionOverridesSnapshot(");
		const assignIndex = registration.indexOf("sessionModelOverrides = updated");

		expect(computeIndex).toBeGreaterThanOrEqual(0);
		expect(appendIndex).toBeGreaterThan(computeIndex);
		expect(assignIndex).toBeGreaterThan(appendIndex);
		expect(registration).toContain("pi.appendEntry.bind(pi)");
		expect(registration).toContain("updated");
	});

	it("routes durable model selection through the frontmatter persistence helper", () => {
		expect(AGENT_MODEL_COMMAND_SRC).toContain("persistAgentModel(");
		expect(AGENT_MODEL_COMMAND_SRC).not.toMatch(
			/writeFile|appendFile|renameSync/,
		);
		expect(INDEX_SRC).toMatch(
			/import\s*\{\s*persistAgentModelFile\s*\}\s*from\s*["']\.\/agent-model-file\.js["']/,
		);
		expect(INDEX_SRC).toContain(
			"persistAgentModel: persistAgentModelFile",
		);
	});
});

describe("background model resolution wiring", () => {
	it("eagerly resolves every parallel invocation before leaving execute context", () => {
		const executeBlock = between(
			SUBAGENT_EXECUTE,
			"// ── V2: Background parallel",
			"// ── V2: Background chain",
		);
		const calls = extractCalls(executeBlock, "resolveInvocation");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("modelResolution: modelResolutionFor(t.agent)");
		expect(executeBlock.indexOf("resolveInvocation(")).toBeLessThan(
			executeBlock.indexOf("launchBackgroundParallel("),
		);
		expect(executeBlock).toMatch(/launchBackgroundParallel\([\s\S]*?invocations/);

		const launchBody = between(
			INDEX_SRC,
			"function launchBackgroundParallel",
			"function launchBackgroundChain",
		);
		expect(launchBody).not.toContain("resolveInvocation(");
		expect(launchBody).toContain("const invocation = invocations[i]");
	});

	it("preflights each background chain step once and reuses the resolved objects", () => {
		const executeBlock = between(
			SUBAGENT_EXECUTE,
			"// ── V2: Background chain",
			"if (params.chain && params.chain.length > 0)",
		);
		expect(executeBlock).toMatch(
			/const preflightInvocations\s*=\s*params\.chain!\.map\(/,
		);
		const calls = extractCalls(executeBlock, "resolveInvocation");
		const preflightCall = calls.find((call) => call.includes("isPreflight: true"));
		const firstCall = calls.find((call) => call.includes("resolvedModel:"));
		expect(preflightCall).toContain("modelResolution: modelResolutionFor(step.agent)");
		expect(firstCall).toContain("resolvedModel: stepResolvedModels[0]");
		expect(executeBlock).toMatch(
			/const stepResolvedModels\s*=\s*preflightInvocations\.map\(/,
		);
		expect(executeBlock).toMatch(
			/launchBackgroundChain\([\s\S]*?firstInvocation[\s\S]*?stepResolvedModels/,
		);
	});

	it("stores one aligned resolved model on every background chain step", () => {
		const chainStepDef = between(INDEX_SRC, "interface ChainStepDef", "interface BackgroundGroup");
		expect(chainStepDef).toMatch(/readonly resolvedModel:\s*ResolvedModelConfig/);
		expect(chainStepDef).not.toMatch(/^\s*model\??:/m);
		expect(chainStepDef).not.toMatch(/^\s*thinkingLevel\??:/m);

		const launchBody = between(
			INDEX_SRC,
			"function launchBackgroundChain",
			"function killBgProcess",
		);
		expect(launchBody).toMatch(/stepResolvedModels:\s*ResolvedModelConfig\[\]/);
		expect(launchBody).toMatch(
			/if\s*\(stepResolvedModels\.length\s*!==\s*params\.chain\.length\)\s*\{[\s\S]*?throw new Error\([\s\S]*?Internal invariant violated:[\s\S]*?\);[\s\S]*?\}/,
		);
		expect(launchBody).toMatch(
			/const chainSteps\s*=\s*params\.chain\.map\(\(step, index\)[\s\S]*?const resolvedModel\s*=\s*stepResolvedModels\[index\];[\s\S]*?if\s*\(!resolvedModel\)\s*\{[\s\S]*?throw new Error\([\s\S]*?Internal invariant violated:[\s\S]*?\);[\s\S]*?\}[\s\S]*?resolvedModel,/,
		);
		expect(launchBody).toMatch(/chainSteps,\s*\n/);
		const firstSpawn = launchBody.indexOf("launchBackgroundAgent(bgAgent)");
		expect(firstSpawn).toBeGreaterThanOrEqual(0);
		expect(launchBody.indexOf("stepResolvedModels.length")).toBeLessThan(firstSpawn);
		expect(launchBody.indexOf("if (!resolvedModel)")).toBeLessThan(firstSpawn);
		expect(launchBody).not.toContain("resolveInvocation(");
	});
});
