// Historical CLI contract fixtures retained for SDK resource-parity comparisons.
// These helpers are not imported by the extension or available as an execution path.
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { normalizeModelString } from "../model-normalize.js";
import type { ResolvedModelConfig } from "../model-resolution.js";
import { ROLE_PROMPT_FLAG } from "../child-system-prompt.js";

export function buildModelArgs(resolved: Pick<ResolvedModelConfig, "model" | "thinkingLevel">): string[] {
	const parsed = resolved.model === undefined ? undefined : normalizeModelString(resolved.model);
	const level = resolved.thinkingLevel ?? parsed?.thinkingLevel;
	return [...(parsed?.base ? ["--model", parsed.base] : []), ...(level ? ["--thinking", level] : [])];
}
export function buildForegroundToolArgs(tools?: string[]): string[] {
	return tools === undefined ? [] : tools.length === 0 ? ["--no-tools"] : ["--tools", tools.join(",")];
}
export function buildBackgroundToolArgs(tools?: string[]): string[] {
	return tools === undefined ? [] : ["--tools", [...new Set([...tools, "__bg_signal"])].join(",")];
}
export function buildIsolationArgs(opts: { noSkills?: boolean; noPromptTemplates?: boolean; noContextFiles?: boolean }): string[] {
	return [...(opts.noSkills ? ["--no-skills"] : []), ...(opts.noPromptTemplates ? ["--no-prompt-templates"] : []), ...(opts.noContextFiles ? ["--no-context-files"] : [])];
}
export function buildSystemPromptArgs(opts: { systemPromptMode?: "append" | "replace"; noSkills?: boolean; noPromptTemplates?: boolean; noContextFiles?: boolean; promptFilePath: string }): string[] {
	return opts.systemPromptMode === "replace"
		? ["--system-prompt", opts.promptFilePath, "--append-system-prompt", "", "--no-skills", "--no-prompt-templates", "--no-context-files"]
		: ["-e", join(dirname(fileURLToPath(import.meta.url)), "..", "child-system-prompt.ts"), `--${ROLE_PROMPT_FLAG}`, opts.promptFilePath, ...buildIsolationArgs(opts)];
}
