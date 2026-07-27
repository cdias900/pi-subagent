import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	isThinkingLevel,
	type SubagentThinkingLevel,
} from "./model-normalize.js";

export const GLOBAL_CONFIG_FILENAME = "subagent-models.json";

export function getGlobalConfigPath(): string {
	return path.join(getAgentDir(), GLOBAL_CONFIG_FILENAME);
}

export interface AgentModelOverride {
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
}

export type SubagentModelConfig = Record<string, AgentModelOverride>;

export interface LoadResult {
	config: SubagentModelConfig;
	error?: string;
	path: string;
}

type ValidationResult =
	| { valid: true; config: SubagentModelConfig }
	| { valid: false; error: string };

const ALLOWED_OVERRIDE_KEYS = new Set(["model", "thinkingLevel"]);
let tempFileSequence = 0;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validateOverride(agent: string, override: unknown): string | undefined {
	if (!isPlainObject(override)) {
		return `override for agent "${agent}" must be a plain object`;
	}

	for (const key of Object.keys(override)) {
		if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
			return `override for agent "${agent}" contains unknown key "${key}"`;
		}
	}

	if ("model" in override && typeof override.model !== "string") {
		return `model for agent "${agent}" must be a string`;
	}

	if (
		"thinkingLevel" in override &&
		(typeof override.thinkingLevel !== "string" ||
			!isThinkingLevel(override.thinkingLevel))
	) {
		return `thinkingLevel for agent "${agent}" must be a canonical thinking level`;
	}

	// Both fields are independently optional, so an empty override is valid.
	return undefined;
}

export function validateSubagentModelConfig(raw: unknown): ValidationResult {
	if (!isPlainObject(raw)) {
		return {
			valid: false,
			error: "configuration root must be a plain object",
		};
	}

	for (const [agent, override] of Object.entries(raw)) {
		const error = validateOverride(agent, override);
		if (error !== undefined) return { valid: false, error };
	}

	return { valid: true, config: raw as SubagentModelConfig };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}

export function loadGlobalConfig(
	filePath = getGlobalConfigPath(),
): LoadResult {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return { config: {}, path: filePath };
		}

		return {
			config: {},
			error: `${filePath}: ${errorMessage(error)}`,
			path: filePath,
		};
	}

	const validation = validateSubagentModelConfig(raw);
	if (!validation.valid) {
		return {
			config: {},
			error: `${filePath}: ${validation.error}`,
			path: filePath,
		};
	}

	return { config: validation.config, path: filePath };
}

function nextSiblingTempPath(filePath: string): string {
	const suffix = `${process.pid}-${Date.now()}-${tempFileSequence++}`;
	return `${filePath}.tmp-${suffix}`;
}

function atomicWriteJson(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });

	const serialized = JSON.stringify(data, null, 2);
	if (serialized === undefined) {
		throw new Error(`Cannot serialize global subagent config for ${filePath}`);
	}

	const tempPath = nextSiblingTempPath(filePath);
	try {
		fs.writeFileSync(tempPath, `${serialized}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		fs.chmodSync(tempPath, 0o600);
		fs.renameSync(tempPath, filePath);
	} catch (error) {
		try {
			fs.unlinkSync(tempPath);
		} catch (cleanupError) {
			if (!hasErrorCode(cleanupError, "ENOENT")) {
				throw new AggregateError(
					[error, cleanupError],
					`Failed to write ${filePath} and clean up ${tempPath}`,
				);
			}
		}
		throw error;
	}
}

function pruneUndefined(override: AgentModelOverride): AgentModelOverride {
	const pruned: AgentModelOverride = {};
	if (override.model !== undefined) pruned.model = override.model;
	if (override.thinkingLevel !== undefined) {
		pruned.thinkingLevel = override.thinkingLevel;
	}
	return pruned;
}

export function saveGlobalOverride(
	agent: string,
	override: AgentModelOverride,
	filePath = getGlobalConfigPath(),
): void {
	const loaded = loadGlobalConfig(filePath);
	if (loaded.error !== undefined) throw new Error(loaded.error);

	const config: SubagentModelConfig = {
		...loaded.config,
		[agent]: pruneUndefined(override),
	};
	atomicWriteJson(filePath, config);
}

export function resetGlobalOverride(
	agent: string,
	filePath = getGlobalConfigPath(),
): void {
	const loaded = loadGlobalConfig(filePath);
	if (loaded.error !== undefined) throw new Error(loaded.error);
	if (!Object.prototype.hasOwnProperty.call(loaded.config, agent)) return;

	const config = { ...loaded.config };
	delete config[agent];
	atomicWriteJson(filePath, config);
}
