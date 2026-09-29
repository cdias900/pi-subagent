import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const SUBAGENT_SETTINGS_FILENAME = "subagent-settings.json";

export interface SubagentSettings {
	allowInvocationModelOverrides: boolean;
}

export interface LoadSubagentSettingsResult {
	settings: SubagentSettings;
	path: string;
	error?: string;
}

export type SubagentSettingsValidationResult =
	| { valid: true; settings: SubagentSettings }
	| { valid: false; error: string };

const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
	allowInvocationModelOverrides: true,
};
const ALLOWED_SETTINGS_KEYS = new Set(["allowInvocationModelOverrides"]);

export function getSubagentSettingsPath(): string {
	return path.join(getAgentDir(), SUBAGENT_SETTINGS_FILENAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function validateSubagentSettings(
	raw: unknown,
): SubagentSettingsValidationResult {
	if (!isPlainObject(raw)) {
		return {
			valid: false,
			error: "configuration root must be a plain object",
		};
	}

	for (const key of Object.keys(raw)) {
		if (!ALLOWED_SETTINGS_KEYS.has(key)) {
			return {
				valid: false,
				error: `configuration contains unknown key "${key}"`,
			};
		}
	}

	const value = raw.allowInvocationModelOverrides;
	if (value !== undefined && typeof value !== "boolean") {
		return {
			valid: false,
			error: "allowInvocationModelOverrides must be a boolean",
		};
	}

	return {
		valid: true,
		settings: {
			allowInvocationModelOverrides:
				value ?? DEFAULT_SUBAGENT_SETTINGS.allowInvocationModelOverrides,
		},
	};
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Load the persistent user policy. A missing file preserves the historical
 * behavior; malformed or schema-invalid files fail extension registration.
 */
export function loadSubagentSettings(
	filePath = getSubagentSettingsPath(),
): LoadSubagentSettingsResult {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return {
				settings: { ...DEFAULT_SUBAGENT_SETTINGS },
				path: filePath,
			};
		}
		return {
			settings: { ...DEFAULT_SUBAGENT_SETTINGS },
			error: `${filePath}: ${errorMessage(error)}`,
			path: filePath,
		};
	}

	const validation = validateSubagentSettings(raw);
	if (!validation.valid) {
		return {
			settings: { ...DEFAULT_SUBAGENT_SETTINGS },
			error: `${filePath}: ${validation.error}`,
			path: filePath,
		};
	}

	return {
		settings: validation.settings,
		path: filePath,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasProperty(value: Record<string, unknown>, key: string): boolean {
	// Downstream resolution reads fields with normal property access, so the
	// policy must also catch inherited values supplied by direct SDK callers or
	// post-validation argument mutation.
	return key in value;
}

/**
 * Return every invocation-level model/reasoning field supplied by the caller.
 * Structured agent input is deliberately opaque: data fields named `model` or
 * `thinkingLevel` inside `input` are not invocation overrides.
 */
export function findInvocationModelOverridePaths(params: unknown): string[] {
	if (!isRecord(params)) return [];

	const paths: string[] = [];
	for (const key of ["model", "thinkingLevel"] as const) {
		if (hasProperty(params, key)) paths.push(key);
	}

	for (const collectionName of ["tasks", "chain"] as const) {
		const collection = params[collectionName];
		if (!Array.isArray(collection)) continue;

		collection.forEach((item, index) => {
			if (!isRecord(item)) return;
			for (const key of ["model", "thinkingLevel"] as const) {
				if (hasProperty(item, key)) {
					paths.push(`${collectionName}[${index}].${key}`);
				}
			}
		});
	}

	return paths;
}

/**
 * Enforce the invocation policy independently of the public tool schema. This
 * protects resumed calls, direct SDK callers, and arguments mutated by another
 * extension after validation.
 */
export function assertInvocationModelOverridesAllowed(
	params: unknown,
	allowed: boolean,
	settingsPath = getSubagentSettingsPath(),
): void {
	if (allowed) return;

	const paths = findInvocationModelOverridePaths(params);
	if (paths.length === 0) return;

	throw new Error(
		[
			`Per-invocation model and reasoning overrides are disabled by ${settingsPath} (allowInvocationModelOverrides: false).`,
			`Remove ${paths.map((itemPath) => `\`${itemPath}\``).join(", ")} from this subagent call; configured session, global, frontmatter, or parent defaults will be used.`,
			"To allow these fields, set allowInvocationModelOverrides to true and run /reload. No subagents were started.",
		].join("\n"),
	);
}
