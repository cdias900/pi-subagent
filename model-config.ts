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
		"model" in override &&
		override.model !== undefined &&
		typeof override.model === "string" &&
		override.model.trim() === ""
	) {
		return `model for agent "${agent}" must not be empty or whitespace-only`;
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

export interface ForceResetResult {
	/** Path of the corrupt-file backup, or undefined when no file existed. */
	backupPath: string | undefined;
	/** Path of the recovered (clean) configuration file. */
	recoveredPath: string;
}

/**
 * Force-reset the global subagent model config without parsing the existing
 * file. Backs up the corrupt bytes beside the original, then atomically writes
 * a clean `{}`. Used by `/agent-model global reset --force` to recover from an
 * unreadable config that blocks its own normal repair path.
 */
export function forceResetGlobalConfig(
	filePath = getGlobalConfigPath(),
): ForceResetResult {
	let backupPath: string | undefined;

	// Read the existing bytes directly (no TOCTOU existsSync check). Only
	// ENOENT means "nothing to back up"; every other read error is fatal and
	// must propagate so we never erase a file we could not back up.
	let raw: Buffer;
	try {
		raw = fs.readFileSync(filePath);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) {
			throw error;
		}
		raw = Buffer.alloc(0);
	}

	if (raw.length > 0) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const base = `${filePath}.corrupt-${timestamp}`;
		backupPath = writeExclusiveBackup(base, raw);
	}

	atomicWriteJson(filePath, {});
	return { backupPath, recoveredPath: filePath };
}

/**
 * Write `bytes` to a backup path using exclusive creation (`wx`) so two resets
 * in the same millisecond cannot silently clobber one another. On `EEXIST`,
 * retry with a short random suffix, bounded to a handful of attempts. If every
 * attempt fails, throw an actionable error WITHOUT touching the original file.
 */
function writeExclusiveBackup(basePath: string, bytes: Buffer): string {
	const maxAttempts = 5;
	let candidate = basePath;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			fs.writeFileSync(candidate, bytes, { flag: "wx", mode: 0o600 });
			return candidate;
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) {
				throw error;
			}
			candidate = `${basePath}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
		}
	}
	throw new Error(
		`Could not create a unique backup for ${basePath} after ${maxAttempts} attempts; the original corrupt file was left untouched. Free disk space or remove conflicting backups and retry.`,
	);
}

/**
 * Format the fail-closed dispatch-time error for a corrupt global config so it
 * is self-serving: it surfaces the offending file path and parse/validation
 * problem (already embedded in `error`) alongside the exact recovery command.
 */
export function formatGlobalConfigDispatchError(error: string): string {
	return [
		error,
		"",
		"The global subagent model configuration is unreadable, so no subagents can be dispatched.",
		"Recovery: run `/agent-model global reset --force` to back up the corrupt file and restore a clean configuration.",
	].join("\n");
}
