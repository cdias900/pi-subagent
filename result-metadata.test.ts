import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildResolvedModelMetadata,
	formatUsageStats,
} from "./index.js";
import type { ResolvedModelConfig } from "./model-resolution.js";

const INDEX_SRC = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts"),
	"utf8",
);

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

function between(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
	expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
	return source.slice(start, end);
}

function objectAfter(source: string, marker: string): string {
	const markerIndex = source.indexOf(marker);
	expect(markerIndex, `missing object marker: ${marker}`).toBeGreaterThanOrEqual(0);
	const start = source.indexOf("{", markerIndex + marker.length);
	expect(start, `missing object start after: ${marker}`).toBeGreaterThan(markerIndex);

	let depth = 0;
	for (let index = start; index < source.length; index++) {
		if (source[index] === "{") depth++;
		if (source[index] === "}") {
			depth--;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}

	throw new Error(`missing object end after: ${marker}`);
}

function expectResolvedMetadata(
	objectSource: string,
	resolvedExpression: string,
): void {
	const escapedExpression = resolvedExpression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	expect(objectSource).toMatch(
		new RegExp(
			`\\.\\.\\.buildResolvedModelMetadata\\(\\s*${escapedExpression}\\s*\\)`,
		),
	);
}

describe("resolved result metadata", () => {
	it("maps all resolved model fields to their result names", () => {
		const resolved: ResolvedModelConfig = {
			model: "openai/gpt-5.4",
			thinkingLevel: "high",
			modelSource: "task",
			thinkingLevelSource: "task",
			source: "task",
		};

		expect(buildResolvedModelMetadata(resolved)).toEqual({
			resolvedModel: "openai/gpt-5.4",
			resolvedThinkingLevel: "high",
			configSource: "task",
		});
	});

	it("omits undefined optional metadata instead of emitting undefined values", () => {
		const resolved: ResolvedModelConfig = {
			modelSource: "parent",
			source: "parent",
		};

		expect(buildResolvedModelMetadata(resolved)).toEqual({
			configSource: "parent",
		});
	});
});

describe("formatUsageStats resolved configuration", () => {
	it("prefers explicit thinking level, then model suffix, then off", () => {
		expect(
			formatUsageStats(EMPTY_USAGE, "openai/gpt-5.4:high", {
				thinkingLevel: "low",
			}),
		).toBe("openai ● gpt-5.4 ● low");
		expect(formatUsageStats(EMPTY_USAGE, "openai/gpt-5.4:high")).toBe(
			"openai ● gpt-5.4 ● high",
		);
		expect(formatUsageStats(EMPTY_USAGE, "openai/gpt-5.4")).toBe(
			"openai ● gpt-5.4 ● off",
		);
	});

	it("appends config source only when supplied", () => {
		expect(
			formatUsageStats(EMPTY_USAGE, "openai/gpt-5.4", {
				source: "session",
			}),
		).toBe("openai ● gpt-5.4 ● off ● session");
		expect(formatUsageStats(EMPTY_USAGE, "openai/gpt-5.4")).toBe(
			"openai ● gpt-5.4 ● off",
		);
	});

	it("preserves provider/model parsing and context-window usage", () => {
		const usage = {
			...EMPTY_USAGE,
			input: 1200,
			output: 300,
			cost: 0.0125,
			contextTokens: 100_000,
			turns: 2,
		};

		expect(
			formatUsageStats(
				usage,
				"anthropic/claude-sonnet-4-20250514:medium",
				{ elapsedMs: 65_000 },
			),
		).toBe(
			"1.5k tokens │ $0.013 │ 50.0% (100k/200k)\n" +
				"2 turns │ anthropic ● claude-sonnet-4-20250514 ● medium │ 1m 5s",
		);
	});

	it("uses the SDK model's actual context window instead of the fallback table", () => {
		const usage = { ...EMPTY_USAGE, contextTokens: 4096 };
		expect(formatUsageStats(usage, "offline-test/mock", { contextWindow: 8192 }))
			.toContain("50.0% (4.1k/8.2k)");
		expect(formatUsageStats(usage, "offline-test/mock")).toContain("ctx:4.1k");
	});

	it("keeps aggregate no-model output unchanged", () => {
		expect(
			formatUsageStats(
				{
					...EMPTY_USAGE,
					input: 1000,
					output: 1000,
					cost: 0.01,
					turns: 2,
				},
				undefined,
				{ elapsedMs: 1000 },
			),
		).toBe("2 turns │ 2.0k tokens │ $0.010 │ 1s");
	});
});

describe("SingleResult creation wiring", () => {
	it("adds resolved metadata to the foreground current result", () => {
		const runSingle = between(
			INDEX_SRC,
			"async function runSingleAgent(",
			"// ── Background agent helpers",
		);
		expectResolvedMetadata(
			objectAfter(runSingle, "const currentResult: SingleResult ="),
			"invocation.resolvedModel",
		);
	});

	it("adds resolved metadata to foreground parallel placeholders", () => {
		const placeholders = between(
			INDEX_SRC,
			"// Initialize placeholder results",
			"const emitParallelUpdate",
		);
		expectResolvedMetadata(
			objectAfter(placeholders, "allResults[i] ="),
			"invocations[i].resolvedModel",
		);
	});

	it.each([
		{
			name: "single background",
			start: "// ── Background mode ──",
			end: "const result = await runSingleAgent",
			expression: "invocation.resolvedModel",
		},
		{
			name: "background parallel",
			start: "function launchBackgroundParallel",
			end: "function launchBackgroundChain",
			expression: "invocation.resolvedModel",
		},
		{
			name: "background chain first step",
			start: "function launchBackgroundChain",
			end: "function killBgProcess",
			expression: "invocation.resolvedModel",
		},
		{
			name: "advanceChain continuation",
			start: "function advanceChain",
			end: "function evictCompletedGroups",
			expression: "stepDef.resolvedModel",
		},
	])("adds resolved metadata to $name results", ({ start, end, expression }) => {
		const route = between(INDEX_SRC, start, end);
		expectResolvedMetadata(objectAfter(route, "result:"), expression);
	});
});

describe("resolved usage rendering wiring", () => {
	it("passes resolved metadata at every per-result usage call", () => {
		const calls = INDEX_SRC.match(
			/formatUsageStats\(\s*(?:r\.usage|bgAgent\.result\.usage),[\s\S]*?\n\s*\}\)/g,
		) ?? [];

		expect(calls).toHaveLength(5);
		for (const call of calls) {
			expect(call).toMatch(
				/(?:r\.model\s*\?\?\s*r\.resolvedModel|bgAgent\.result\.model\s*\?\?\s*bgAgent\.result\.resolvedModel)/,
			);
			expect(call).toMatch(
				/thinkingLevel:\s*(?:r\.resolvedThinkingLevel|bgAgent\.result\.resolvedThinkingLevel)/,
			);
			expect(call).toMatch(
				/source:\s*(?:r\.configSource|bgAgent\.result\.configSource)/,
			);
		}
	});

	it("keeps child message updates from overwriting resolved metadata", () => {
		const childMessagePaths = [
			between(
				INDEX_SRC,
				"async function runSingleAgent(",
				"// ── Background agent helpers",
			),
			between(
				INDEX_SRC,
				"function launchBackgroundAgent(",
				"function handleBgSignal",
			),
		];

		for (const pathSource of childMessagePaths) {
			expect(pathSource).not.toMatch(
				/\.(?:resolvedModel|resolvedThinkingLevel|configSource)\s*=/,
			);
		}
	});
});
