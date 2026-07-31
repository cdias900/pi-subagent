import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	SESSION_OVERRIDES_CUSTOM_TYPE,
	SESSION_SNAPSHOT_VERSION,
	appendSessionOverridesSnapshot,
	computeUpdatedOverrides,
	restoreSessionOverrides,
	type SessionOverridesSnapshot,
} from "./model-session.js";
import type {
	AgentModelOverride,
	SubagentModelConfig,
} from "./model-config.js";

const TIMESTAMP = "2026-07-23T12:00:00.000Z";

function customEntry(
	id: string,
	parentId: string | null,
	data: unknown,
	customType = SESSION_OVERRIDES_CUSTOM_TYPE,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: TIMESTAMP,
		customType,
		data,
	};
}

function modelChangeEntry(
	id: string,
	parentId: string | null,
): SessionEntry {
	return {
		type: "model_change",
		id,
		parentId,
		timestamp: TIMESTAMP,
		provider: "openai",
		modelId: "gpt-5.6-sol",
	};
}

describe("current-session model override snapshots", () => {
	it("defines the custom entry type and snapshot version", () => {
		expect(SESSION_OVERRIDES_CUSTOM_TYPE).toBe(
			"subagent-model-overrides",
		);
		expect(SESSION_SNAPSHOT_VERSION).toBe(1);
	});

	describe("restoreSessionOverrides", () => {
		it("returns an empty config for an empty branch", () => {
			expect(restoreSessionOverrides([])).toEqual({});
		});

		it("ignores other custom types and non-custom entries", () => {
			const branch: SessionEntry[] = [
				customEntry(
					"entry-1",
					null,
					{
						version: SESSION_SNAPSHOT_VERSION,
						overrides: { scout: { model: "ignored/custom" } },
					},
					"another-extension",
				),
				modelChangeEntry("entry-2", "entry-1"),
			];

			expect(restoreSessionOverrides(branch)).toEqual({});
		});

		it("uses the latest valid snapshot in branch order", () => {
			const branch: SessionEntry[] = [
				customEntry("entry-1", null, {
					version: SESSION_SNAPSHOT_VERSION,
					overrides: { scout: { model: "openai/first" } },
				}),
				modelChangeEntry("entry-2", "entry-1"),
				customEntry("entry-3", "entry-2", {
					version: SESSION_SNAPSHOT_VERSION,
					overrides: {
						scout: {
							model: "anthropic/latest",
							thinkingLevel: "high",
						},
					},
				}),
			];

			expect(restoreSessionOverrides(branch)).toEqual({
				scout: {
					model: "anthropic/latest",
					thinkingLevel: "high",
				},
			});
		});

		it("does not let malformed matching entries erase the latest valid snapshot", () => {
			const expected: SubagentModelConfig = {
				executor: { model: "openai/gpt-5.6-sol", thinkingLevel: "max" },
			};
			const branch: SessionEntry[] = [
				customEntry("entry-1", null, {
					version: SESSION_SNAPSHOT_VERSION,
					overrides: expected,
				}),
				customEntry("entry-2", "entry-1", undefined),
				customEntry("entry-3", "entry-2", {
					version: SESSION_SNAPSHOT_VERSION,
				}),
				customEntry("entry-4", "entry-3", {
					version: SESSION_SNAPSHOT_VERSION,
					overrides: [],
				}),
			];

			expect(restoreSessionOverrides(branch)).toEqual(expected);
		});

		it.each([
			["non-object agent override", { scout: "oops" }],
			["numeric model", { scout: { model: 42 } }],
			["invalid thinking level", { scout: { thinkingLevel: "turbo" } }],
			[
				"unknown override key",
				{ scout: { model: "openai/future", temperature: 0.2 } },
			],
		])(
			"ignores a %s without erasing the latest valid snapshot",
			(_description, malformedOverrides) => {
				const expected: SubagentModelConfig = {
					planner: { model: "openai/valid", thinkingLevel: "medium" },
				};
				const branch: SessionEntry[] = [
					customEntry("entry-1", null, {
						version: SESSION_SNAPSHOT_VERSION,
						overrides: expected,
					}),
					customEntry("entry-2", "entry-1", {
						version: SESSION_SNAPSHOT_VERSION,
						overrides: malformedOverrides,
					}),
				];

				expect(restoreSessionOverrides(branch)).toEqual(expected);
			},
		);

		it.each([
			["missing", undefined],
			["unknown", 99],
		] as const)(
			"accepts a %s snapshot version when overrides are fully v1-compatible",
			(_description, version) => {
				const data = {
					...(version === undefined ? {} : { version }),
					overrides: { planner: { thinkingLevel: "medium" as const } },
				};

				expect(
					restoreSessionOverrides([customEntry("entry-1", null, data)]),
				).toEqual(data.overrides);
			},
		);

		it("skips an incompatible unknown-version snapshot without erasing the latest valid one", () => {
			const expected: SubagentModelConfig = {
				scout: { model: "anthropic/valid", thinkingLevel: "high" },
			};
			const branch: SessionEntry[] = [
				customEntry("entry-1", null, {
					version: SESSION_SNAPSHOT_VERSION,
					overrides: expected,
				}),
				customEntry("entry-2", "entry-1", {
					version: 99,
					overrides: {
						scout: { model: "anthropic/future", routingMode: "future" },
					},
				}),
			];

			expect(restoreSessionOverrides(branch)).toEqual(expected);
		});

		it("ignores snapshots whose overrides are invalid", () => {
			const branch: SessionEntry[] = [
				customEntry("entry-1", null, null),
				customEntry("entry-2", "entry-1", { overrides: null }),
				customEntry("entry-3", "entry-2", { overrides: "invalid" }),
				customEntry("entry-4", "entry-3", { overrides: [] }),
			];

			expect(restoreSessionOverrides(branch)).toEqual({});
		});

		it("clones restored data so callers cannot mutate the session entry", () => {
			const data: SessionOverridesSnapshot = {
				version: SESSION_SNAPSHOT_VERSION,
				overrides: {
					scout: { model: "anthropic/claude", thinkingLevel: "high" },
				},
			};
			const restored = restoreSessionOverrides([
				customEntry("entry-1", null, data),
			]);

			restored.scout!.model = "mutated/model";
			delete restored.scout!.thinkingLevel;

			expect(data.overrides).toEqual({
				scout: { model: "anthropic/claude", thinkingLevel: "high" },
			});
		});
	});

	describe("computeUpdatedOverrides", () => {
		it("sets an override without mutating the input, sibling, or inserted override", () => {
			const sibling: AgentModelOverride = { thinkingLevel: "low" };
			const current: SubagentModelConfig = {
				scout: { model: "openai/original" },
				planner: sibling,
			};
			const replacement: AgentModelOverride = {
				model: "anthropic/replacement",
				thinkingLevel: "high",
			};

			const updated = computeUpdatedOverrides(current, "scout", replacement);

			expect(updated).not.toBe(current);
			expect(updated).toEqual({
				scout: {
					model: "anthropic/replacement",
					thinkingLevel: "high",
				},
				planner: { thinkingLevel: "low" },
			});
			expect(current).toEqual({
				scout: { model: "openai/original" },
				planner: { thinkingLevel: "low" },
			});
			expect(updated.planner).toBe(sibling);
			expect(updated.scout).not.toBe(replacement);

			replacement.model = "mutated/after-update";
			expect(updated.scout?.model).toBe("anthropic/replacement");
		});

		it("prunes undefined fields while preserving immutable shallow siblings", () => {
			const sibling: AgentModelOverride = { thinkingLevel: "low" };
			const current: SubagentModelConfig = { planner: sibling };
			const replacement: AgentModelOverride = {
				model: undefined,
				thinkingLevel: undefined,
			};

			const updated = computeUpdatedOverrides(current, "scout", replacement);

			expect(updated).toEqual({ planner: { thinkingLevel: "low" }, scout: {} });
			expect(updated).not.toBe(current);
			expect(current).toEqual({ planner: { thinkingLevel: "low" } });
			expect(updated.planner).toBe(sibling);
			expect(updated.scout).not.toBe(replacement);
			expect("model" in updated.scout!).toBe(false);
			expect("thinkingLevel" in updated.scout!).toBe(false);
			expect("model" in replacement).toBe(true);
			expect("thinkingLevel" in replacement).toBe(true);
		});

		it("deletes an existing override on undefined without mutating the input", () => {
			const current: SubagentModelConfig = {
				scout: { model: "openai/scout" },
				planner: { model: "openai/planner" },
			};

			const updated = computeUpdatedOverrides(current, "scout", undefined);

			expect(updated).toEqual({ planner: { model: "openai/planner" } });
			expect(updated).not.toBe(current);
			expect(current).toEqual({
				scout: { model: "openai/scout" },
				planner: { model: "openai/planner" },
			});
		});

		it("handles deleting a missing key by returning a new unchanged config", () => {
			const current: SubagentModelConfig = {
				planner: { thinkingLevel: "medium" },
			};

			const updated = computeUpdatedOverrides(current, "missing", undefined);

			expect(updated).toEqual(current);
			expect(updated).not.toBe(current);
		});
	});

	describe("appendSessionOverridesSnapshot", () => {
		it("appends the exact custom type and versioned snapshot", () => {
			const appendEntry = vi.fn(
				(_customType: string, _data: unknown): void => undefined,
			);
			const overrides: SubagentModelConfig = {
				executor: { model: "openai/gpt-5.6-sol", thinkingLevel: "max" },
			};

			appendSessionOverridesSnapshot(appendEntry, overrides);

			expect(appendEntry).toHaveBeenCalledOnce();
			expect(appendEntry).toHaveBeenCalledWith(
				"subagent-model-overrides",
				{
					version: 1,
					overrides,
				},
			);
		});

		it("isolates appended snapshot data from later source mutation", () => {
			const appendEntry = vi.fn(
				(_customType: string, _data: unknown): void => undefined,
			);
			const overrides: SubagentModelConfig = {
				scout: { model: "anthropic/original", thinkingLevel: "high" },
			};

			appendSessionOverridesSnapshot(appendEntry, overrides);
			overrides.scout!.model = "mutated/after-append";
			overrides.planner = { model: "new/after-append" };

			expect(appendEntry.mock.calls[0]?.[1]).toEqual({
				version: SESSION_SNAPSHOT_VERSION,
				overrides: {
					scout: {
						model: "anthropic/original",
						thinkingLevel: "high",
					},
				},
			});
		});
	});
});
