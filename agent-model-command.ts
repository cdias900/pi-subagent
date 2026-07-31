import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@mariozechner/pi-tui";
import type { AgentConfig } from "./agents.js";
import {
	type AgentModelOverride,
	type ForceResetResult,
	type LoadResult,
	type SubagentModelConfig,
} from "./model-config.js";
import {
	CANONICAL_THINKING_LEVELS,
	isThinkingLevel,
	splitProviderModel,
	type SubagentThinkingLevel,
} from "./model-normalize.js";
import {
	getSupportedThinkingLevelsCompat,
	type ModelCatalogPort,
	type ResolvedModelConfig,
	validateResolvedModel,
} from "./model-resolution.js";

export type AgentModelScope = "session" | "global";

export type ParsedAgentModelCommand =
	| { kind: "guided" }
	| { kind: "guidedAgent"; agent: string }
	| {
			kind: "direct";
			scope: AgentModelScope;
			agent: string;
			model: string;
			thinkingLevel: SubagentThinkingLevel | undefined;
	  }
	| { kind: "reset"; scope: AgentModelScope; agent: string }
	| { kind: "forceReset" }
	| { kind: "error"; message: string };

interface EffectiveConfigOptions {
	session?: AgentModelOverride;
	global?: AgentModelOverride;
	parent?: AgentModelOverride;
}

interface EffectiveConfigOutcome {
	effective: ResolvedModelConfig;
	globalError: string | undefined;
}

export interface AgentModelCommandDeps {
	discover(ctx: ExtensionCommandContext): readonly AgentConfig[];
	getSessionOverrides(): SubagentModelConfig;
	setSessionOverride(
		agent: string,
		override: AgentModelOverride | undefined,
	): void | Promise<void>;
	loadGlobal(): LoadResult;
	saveGlobal(
		agent: string,
		override: AgentModelOverride,
	): void | Promise<void>;
	resetGlobal(agent: string): void | Promise<void>;
	forceResetGlobal(): ForceResetResult;
	makePort(ctx: ExtensionCommandContext): ModelCatalogPort;
	parentFor(ctx: ExtensionCommandContext): AgentModelOverride;
	buildEffectiveConfig(
		agent: Pick<AgentConfig, "model">,
		options: EffectiveConfigOptions,
	): ResolvedModelConfig;
}

const USAGE = [
	"Usage:",
	"  /agent-model",
	"  /agent-model <agent>",
	"  /agent-model session <agent> <provider/model> [level]",
	"  /agent-model global <agent> <provider/model> [level]",
	"  /agent-model session <agent> reset",
	"  /agent-model global <agent> reset",
	"  /agent-model global reset --force",
	`Valid levels: ${CANONICAL_THINKING_LEVELS.join(", ")}`,
].join("\n");

const DEFAULT_MODEL_VALUE = "__default__";
const DEFAULT_REASONING_LABEL = "Use agent default";
const SESSION_SCOPE_LABEL = "Current Pi session";
const GLOBAL_SCOPE_LABEL = "Global default";
const SCOPE_CHOICES = [SESSION_SCOPE_LABEL, GLOBAL_SCOPE_LABEL] as const;

type ExtensionMode = "tui" | "rpc" | "json" | "print";

function errorWithUsage(message: string): ParsedAgentModelCommand {
	return { kind: "error", message: `${message}\n\n${USAGE}` };
}

export function parseAgentModelArgs(argStr: string): ParsedAgentModelCommand {
	const trimmed = argStr.trim();
	if (trimmed === "") return { kind: "guided" };

	const tokens = trimmed.split(/\s+/);
	const first = tokens[0];
	if (tokens.length === 1 && first !== "session" && first !== "global") {
		return { kind: "guidedAgent", agent: first };
	}

	if (first !== "session" && first !== "global") {
		return errorWithUsage(`Unknown /agent-model form "${first}".`);
	}

	if (tokens.length < 3) {
		return errorWithUsage(`Missing arguments for the ${first} form.`);
	}

	const agent = tokens[1];
	const modelOrReset = tokens[2];

	// Full-global force reset: /agent-model global reset --force
	// Distinct from the per-agent reset form (global <agent> reset): this resets
	// the entire global config without parsing it, to recover from corruption.
	if (agent === "reset") {
		if (first !== "global") {
			return errorWithUsage(
				"The full-config reset form is only valid for the global scope.",
			);
		}
		if (tokens.length === 3 && modelOrReset === "--force") {
			return { kind: "forceReset" };
		}
		return errorWithUsage(
			'Use "/agent-model global reset --force" to reset the entire global configuration.',
		);
	}

	if (modelOrReset === "reset") {
		if (tokens.length !== 3) {
			return errorWithUsage("The reset form does not accept extra arguments.");
		}
		return { kind: "reset", scope: first, agent };
	}

	if (tokens.length > 4) {
		return errorWithUsage("Too many arguments for the direct form.");
	}

	const level = tokens[3];
	if (level !== undefined && !isThinkingLevel(level)) {
		return errorWithUsage(
			`Invalid reasoning level "${level}". Valid levels: ${CANONICAL_THINKING_LEVELS.join(", ")}.`,
		);
	}

	return {
		kind: "direct",
		scope: first,
		agent,
		model: modelOrReset,
		thinkingLevel: level,
	};
}

// The pinned 0.56.1 ExtensionCommandContext type predates ctx.mode. Live Pi
// exposes this field, so keep the compatibility bridge structural and narrow.
function getExtensionMode(ctx: ExtensionCommandContext): ExtensionMode | undefined {
	const mode = (ctx as ExtensionCommandContext & { mode?: unknown }).mode;
	return mode === "tui" ||
		mode === "rpc" ||
		mode === "json" ||
		mode === "print"
		? mode
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withOverride(
	config: SubagentModelConfig,
	agent: string,
	override: AgentModelOverride | undefined,
): SubagentModelConfig {
	const updated = { ...config };
	if (override === undefined) delete updated[agent];
	else updated[agent] = { ...override };
	return updated;
}

function findAgent(
	agents: readonly AgentConfig[],
	agentName: string,
): AgentConfig | undefined {
	return agents.find((agent) => agent.name === agentName);
}

function unknownAgentMessage(
	agentName: string,
	agents: readonly AgentConfig[],
): string {
	const available = agents.map((agent) => agent.name).join(", ") || "none";
	return `Unknown agent "${agentName}". Available agents: ${available}.`;
}

function directModeError(): string {
	return (
		"Direct /agent-model forms require a live TUI or RPC UI. " +
		"In headless modes, pass model and thinkingLevel to the subagent tool instead."
	);
}

function guidedModeError(agentName?: string): string {
	const agent = agentName ?? "<agent>";
	return [
		"Guided /agent-model selection is available only in TUI mode.",
		"Use direct syntax instead:",
		`  /agent-model session ${agent} <provider/model> [level]`,
		`  /agent-model global ${agent} <provider/model> [level]`,
		`  /agent-model session ${agent} reset`,
		`  /agent-model global ${agent} reset`,
	].join("\n");
}

function directResolvedConfig(
	parsed: Extract<ParsedAgentModelCommand, { kind: "direct" }>,
): ResolvedModelConfig {
	return {
		model: parsed.model,
		thinkingLevel: parsed.thinkingLevel,
		modelSource: parsed.scope,
		thinkingLevelSource:
			parsed.thinkingLevel === undefined ? undefined : parsed.scope,
		source: parsed.scope,
	};
}

function validateDirectSelection(
	parsed: Extract<ParsedAgentModelCommand, { kind: "direct" }>,
	port: ModelCatalogPort,
): string | undefined {
	const validation = validateResolvedModel(directResolvedConfig(parsed), port, {
		agentName: parsed.agent,
	});
	return validation.ok ? undefined : validation.error;
}

function scopeFromChoice(choice: string): AgentModelScope | undefined {
	if (choice === SESSION_SCOPE_LABEL) return "session";
	if (choice === GLOBAL_SCOPE_LABEL) return "global";
	return undefined;
}

function scopeLabel(scope: AgentModelScope): string {
	return scope === "session" ? SESSION_SCOPE_LABEL : GLOBAL_SCOPE_LABEL;
}

function successMessage(
	agentName: string,
	scope: AgentModelScope,
	effective: ResolvedModelConfig,
): string {
	return [
		`Agent "${agentName}" updated:`,
		`model ${effective.model ?? "agent default"};`,
		`reasoning ${effective.thinkingLevel ?? "agent/model default"};`,
		`source ${effective.source};`,
		`scope ${scopeLabel(scope)} (${scope}).`,
	].join(" ");
}

function effectiveConfigForChange(
	agent: AgentConfig,
	scope: AgentModelScope,
	override: AgentModelOverride | undefined,
	ctx: ExtensionCommandContext,
	deps: AgentModelCommandDeps,
): EffectiveConfigOutcome {
	const session = deps.getSessionOverrides();
	const globalLoad = deps.loadGlobal();

	// Global-scope writes must merge into the existing file, so fail closed on a
	// corrupt global config — the user should run /agent-model global reset --force.
	if (scope === "global" && globalLoad.error !== undefined) {
		throw new Error(globalLoad.error);
	}

	// Session-scope writes tolerate a corrupt global file: ignore its defaults
	// and surface the problem as a non-fatal warning after the write succeeds.
	const global = globalLoad.error !== undefined ? {} : globalLoad.config;
	const nextSession =
		scope === "session"
			? withOverride(session, agent.name, override)
			: session;
	const nextGlobal =
		scope === "global"
			? withOverride(global, agent.name, override)
			: global;

	const effective = deps.buildEffectiveConfig(agent, {
		session: nextSession[agent.name],
		global: nextGlobal[agent.name],
		parent: deps.parentFor(ctx),
	});
	return { effective, globalError: globalLoad.error };
}

async function persistChange(
	agent: AgentConfig,
	scope: AgentModelScope,
	override: AgentModelOverride | undefined,
	ctx: ExtensionCommandContext,
	deps: AgentModelCommandDeps,
): Promise<void> {
	// Resolve every fallible config dependency before the single scoped write.
	const { effective, globalError } = effectiveConfigForChange(
		agent,
		scope,
		override,
		ctx,
		deps,
	);

	if (scope === "session") {
		await deps.setSessionOverride(agent.name, override);
	} else if (override === undefined) {
		await deps.resetGlobal(agent.name);
	} else {
		await deps.saveGlobal(agent.name, override);
	}

	ctx.ui.notify(successMessage(agent.name, scope, effective), "info");

	if (scope === "session" && globalError !== undefined) {
		ctx.ui.notify(
			`Warning: the global subagent model config is unreadable (${globalError}). The session override was applied, but global defaults were ignored. Run \`/agent-model global reset --force\` to repair the global config.`,
			"warning",
		);
	}
}

function formatEffectiveConfigRow(
	agent: AgentConfig,
	effective: ResolvedModelConfig,
): string {
	const level =
		effective.thinkingLevel === undefined
			? ""
			: ` · ${effective.thinkingLevel}`;
	return `${agent.name} — ${effective.model ?? "agent default"}${level} (${effective.source})`;
}

async function selectModel(
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) =>
		`${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
	);
	const items: SelectItem[] = [
		{
			value: DEFAULT_MODEL_VALUE,
			label: DEFAULT_REASONING_LABEL,
			description: "Clear this scope's override",
		},
		...models.map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: `${model.provider}/${model.id}`,
			description: model.name,
		})),
	];

	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Choose a model")), 0, 0),
		);

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(
			new Text(
				theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
				0,
				0,
			),
		);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function handleDirectOrReset(
	parsed: Extract<
		ParsedAgentModelCommand,
		{ kind: "direct" | "reset" }
	>,
	ctx: ExtensionCommandContext,
	deps: AgentModelCommandDeps,
): Promise<void> {
	const agents = deps.discover(ctx);
	const agent = findAgent(agents, parsed.agent);
	if (agent === undefined) {
		ctx.ui.notify(unknownAgentMessage(parsed.agent, agents), "error");
		return;
	}

	if (parsed.kind === "direct") {
		const validationError = validateDirectSelection(
			parsed,
			deps.makePort(ctx),
		);
		if (validationError !== undefined) {
			ctx.ui.notify(validationError, "error");
			return;
		}
		await persistChange(
			agent,
			parsed.scope,
			{
				model: parsed.model,
				thinkingLevel: parsed.thinkingLevel,
			},
			ctx,
			deps,
		);
		return;
	}

	await persistChange(agent, parsed.scope, undefined, ctx, deps);
}

async function handleGuided(
	parsed: Extract<
		ParsedAgentModelCommand,
		{ kind: "guided" | "guidedAgent" }
	>,
	ctx: ExtensionCommandContext,
	deps: AgentModelCommandDeps,
): Promise<void> {
	const agents = deps.discover(ctx);
	if (agents.length === 0) {
		ctx.ui.notify("No agents are available for model selection.", "warning");
		return;
	}

	const session = deps.getSessionOverrides();
	const globalLoad = deps.loadGlobal();
	const global = globalLoad.error !== undefined ? {} : globalLoad.config;
	if (globalLoad.error !== undefined) {
		ctx.ui.notify(
			`Warning: the global subagent model config is unreadable (${globalLoad.error}). Global defaults will be ignored for this selection. Run \`/agent-model global reset --force\` to repair the global config.`,
			"warning",
		);
	}
	const parent = deps.parentFor(ctx);
	let agent: AgentConfig | undefined;

	if (parsed.kind === "guidedAgent") {
		agent = findAgent(agents, parsed.agent);
		if (agent === undefined) {
			ctx.ui.notify(unknownAgentMessage(parsed.agent, agents), "error");
			return;
		}
	} else {
		const rowToAgent = new Map<string, string>();
		const rows = agents.map((candidate) => {
			const effective = deps.buildEffectiveConfig(candidate, {
				session: session[candidate.name],
				global: global[candidate.name],
				parent,
			});
			const row = formatEffectiveConfigRow(candidate, effective);
			rowToAgent.set(row, candidate.name);
			return row;
		});
		const choice = await ctx.ui.select("Choose an agent", rows);
		if (choice === undefined) return;
		const agentName = rowToAgent.get(choice);
		if (agentName === undefined) return;
		agent = findAgent(agents, agentName);
		if (agent === undefined) return;
	}

	const modelChoice = await selectModel(ctx);
	if (modelChoice === undefined) return;

	if (modelChoice === DEFAULT_MODEL_VALUE) {
		const scopeChoice = await ctx.ui.select("Save where?", [...SCOPE_CHOICES]);
		if (scopeChoice === undefined) return;
		const scope = scopeFromChoice(scopeChoice);
		if (scope === undefined) return;
		await persistChange(agent, scope, undefined, ctx, deps);
		return;
	}

	const port = deps.makePort(ctx);
	const { provider, modelId } = splitProviderModel(modelChoice);
	const selectedModel = port.findExact(provider, modelId);
	if (selectedModel === undefined) {
		ctx.ui.notify(
			`Model "${modelChoice}" is no longer available. Reopen /agent-model and choose another model.`,
			"error",
		);
		return;
	}

	const supportedLevels = getSupportedThinkingLevelsCompat(selectedModel);
	const levelChoice = await ctx.ui.select("Reasoning level", [
		...supportedLevels,
		DEFAULT_REASONING_LABEL,
	]);
	if (levelChoice === undefined) return;
	const thinkingLevel =
		levelChoice === DEFAULT_REASONING_LABEL ? undefined : levelChoice;
	if (
		thinkingLevel !== undefined &&
		(!isThinkingLevel(thinkingLevel) ||
			!supportedLevels.includes(thinkingLevel))
	) {
		ctx.ui.notify(
			`Reasoning level "${thinkingLevel}" is not supported by "${modelChoice}". Supported: ${supportedLevels.join(", ")}.`,
			"error",
		);
		return;
	}

	const scopeChoice = await ctx.ui.select("Save where?", [...SCOPE_CHOICES]);
	if (scopeChoice === undefined) return;
	const scope = scopeFromChoice(scopeChoice);
	if (scope === undefined) return;

	const validation = validateResolvedModel(
		{
			model: modelChoice,
			thinkingLevel,
			modelSource: scope,
			thinkingLevelSource:
				thinkingLevel === undefined ? undefined : scope,
			source: scope,
		},
		port,
		{ agentName: agent.name },
	);
	if (!validation.ok) {
		ctx.ui.notify(validation.error, "error");
		return;
	}

	await persistChange(
		agent,
		scope,
		{
			model: modelChoice,
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		},
		ctx,
		deps,
	);
}

export function registerAgentModelCommand(
	pi: ExtensionAPI,
	deps: AgentModelCommandDeps,
): void {
	pi.registerCommand("agent-model", {
		description:
			"Choose a subagent model and reasoning level for this session or globally",
		handler: async (args, ctx) => {
			const parsed = parseAgentModelArgs(args ?? "");
			if (parsed.kind === "error") {
				ctx.ui.notify(parsed.message, "warning");
				return;
			}

			if (parsed.kind === "forceReset") {
				try {
					const result = deps.forceResetGlobal();
					const lines = [
						"Global subagent model configuration reset.",
						`Recovered: ${result.recoveredPath}`,
					];
					if (result.backupPath !== undefined) {
						lines.push(`Backup of corrupt file: ${result.backupPath}`);
					} else {
						lines.push(
							"No existing file was found; wrote a clean empty configuration.",
						);
					}
					ctx.ui.notify(lines.join("\n"), "info");
				} catch (error) {
					ctx.ui.notify(
						`Unable to force-reset global configuration: ${errorMessage(error)}`,
						"error",
					);
				}
				return;
			}

			if (parsed.kind === "direct" || parsed.kind === "reset") {
				const mode = getExtensionMode(ctx);
				if (!ctx.hasUI || (mode !== "tui" && mode !== "rpc")) {
					ctx.ui.notify(directModeError(), "error");
					return;
				}
				try {
					await handleDirectOrReset(parsed, ctx, deps);
				} catch (error) {
					ctx.ui.notify(
						`Unable to update /agent-model configuration: ${errorMessage(error)}`,
						"error",
					);
				}
				return;
			}

			if (getExtensionMode(ctx) !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(
					guidedModeError(
						parsed.kind === "guidedAgent" ? parsed.agent : undefined,
					),
					"warning",
				);
				return;
			}

			try {
				await handleGuided(parsed, ctx, deps);
			} catch (error) {
				ctx.ui.notify(
					`Unable to run /agent-model: ${errorMessage(error)}`,
					"error",
				);
			}
		},
	});
}
