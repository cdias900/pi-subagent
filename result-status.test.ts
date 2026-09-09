import { describe, expect, it, vi } from "vitest";
import { handleBgSignal } from "./index.js";
import { isSuccessfulResult, processExitCode } from "./result-status.js";

describe("subagent terminal completion", () => {
	it.each(["error", "aborted", "length"])("does not publish exit-zero results ending with %s", (stopReason) => {
		const publish = vi.fn();
		const result = { exitCode: 0, stopReason };
		if (isSuccessfulResult(result)) publish(result);
		expect(publish).not.toHaveBeenCalled();
		expect([result].filter(isSuccessfulResult)).toHaveLength(0);
	});
	it("allows a successful terminal retry despite a historical error", () => {
		const result = { exitCode: 0, stopReason: "stop", errorMessage: "historical recovered timeout" };
		expect(isSuccessfulResult(result)).toBe(true);
	});
	it("keeps tool-only protocol success without requiring final text", () => {
		expect(isSuccessfulResult({ exitCode: 0 })).toBe(true);
		expect(isSuccessfulResult({ exitCode: 0, stopReason: "endTurn" })).toBe(true);
	});
	it("treats signal termination and failed exits as failures", () => {
		expect(processExitCode(null)).toBe(1);
		expect(isSuccessfulResult({ exitCode: processExitCode(null), stopReason: "stop" })).toBe(false);
		expect(isSuccessfulResult({ exitCode: 143, stopReason: "stop" })).toBe(false);
		expect(isSuccessfulResult({ exitCode: -1, stopReason: "stop" })).toBe(false);
		expect(processExitCode(0)).toBe(0);
	});
	it("preserves explicit done signals followed by intentional process cleanup", () => {
		expect(isSuccessfulResult({ exitCode: processExitCode(null), completionSignal: "done", stopReason: "toolUse" })).toBe(true);
		expect(isSuccessfulResult({ exitCode: 143, completionSignal: "done" })).toBe(true);
		expect(isSuccessfulResult({ exitCode: 0, completionSignal: "error", stopReason: "stop" })).toBe(false);
		expect(isSuccessfulResult({ exitCode: 0, completionSignal: "done", stopReason: "error" })).toBe(false);
	});
	it("counts a mixed parallel batch without discarding successful results", () => {
		const results = [{ exitCode: 0, stopReason: "stop" }, { exitCode: 0, stopReason: "error" }, { exitCode: 1 }];
		expect(results.filter(isSuccessfulResult)).toEqual([results[0]]);
	});
});


function backgroundFixture(stopReason: string, exitCode = 0): Parameters<typeof handleBgSignal>[0] {
	return {
		id: "fixture", agent: "fixture", task: "synthetic", prompt: "synthetic", promptKind: "task",
		proc: null, status: "running", startTime: 0, cwd: "/tmp", spawnArgs: [],
		agentConfig: { name: "fixture", description: "synthetic", systemPrompt: "", source: "user", filePath: "/tmp/fixture.md" },
		result: { agent: "fixture", agentSource: "user", task: "synthetic", exitCode, stopReason,
			errorMessage: "historical error", messages: [], stderr: "", startTime: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } },
	};
}

describe("background done signal publication path", () => {
	it.each(["error", "aborted", "length"])("handles a done signal from a %s message as an error", (stopReason) => {
		const agent = backgroundFixture(stopReason);
		handleBgSignal(agent, { status: "done", summary: "partial output" });
		expect(agent.status).toBe("error");
		expect(agent.result.completionSignal).toBe("error");
	});
	it("accepts a valid tool-only done signal with historical retry error text", () => {
		const agent = backgroundFixture("toolUse", -1);
		handleBgSignal(agent, { status: "done", summary: "complete" });
		expect(agent.status).toBe("done");
		expect(agent.result.completionSignal).toBe("done");
	});
});
