import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	validateSubagentModelConfig,
	type AgentModelOverride,
	type SubagentModelConfig,
} from "./model-config.js";

export const SESSION_OVERRIDES_CUSTOM_TYPE = "subagent-model-overrides";
export const SESSION_SNAPSHOT_VERSION = 1;

export interface SessionOverridesSnapshot {
	version: number;
	overrides: SubagentModelConfig;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotOverrides(entry: SessionEntry): SubagentModelConfig | undefined {
	if (
		entry.type !== "custom" ||
		entry.customType !== SESSION_OVERRIDES_CUSTOM_TYPE ||
		!isObject(entry.data)
	) {
		return undefined;
	}

	// Treat version as advisory so v1-compatible future snapshots survive
	// downgrades; shared validation skips incompatible future shapes.
	const validation = validateSubagentModelConfig(entry.data.overrides);
	return validation.valid ? validation.config : undefined;
}

export function restoreSessionOverrides(
	branch: readonly SessionEntry[],
): SubagentModelConfig {
	let latest: SubagentModelConfig = {};

	for (const entry of branch) {
		const overrides = snapshotOverrides(entry);
		if (overrides === undefined) continue;

		latest = structuredClone(overrides);
	}

	return latest;
}

export function computeUpdatedOverrides(
	current: SubagentModelConfig,
	agent: string,
	override: AgentModelOverride | undefined,
): SubagentModelConfig {
	const updated = { ...current };

	if (override === undefined) {
		delete updated[agent];
	} else {
		const normalized: AgentModelOverride = {};
		if (override.model !== undefined) normalized.model = override.model;
		if (override.thinkingLevel !== undefined) {
			normalized.thinkingLevel = override.thinkingLevel;
		}
		updated[agent] = normalized;
	}

	return updated;
}

export function appendSessionOverridesSnapshot(
	appendEntry: (customType: string, data: unknown) => void,
	overrides: SubagentModelConfig,
): void {
	const snapshot: SessionOverridesSnapshot = {
		version: SESSION_SNAPSHOT_VERSION,
		overrides: structuredClone(overrides),
	};

	appendEntry(SESSION_OVERRIDES_CUSTOM_TYPE, snapshot);
}
