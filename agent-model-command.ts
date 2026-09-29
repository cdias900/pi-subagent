import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Text,
} from "@mariozechner/pi-tui";
import type { AgentConfig } from "./agents.js";
import type {
	AgentModelFileChange,
	AgentModelFileResult,
} from "./agent-model-file.js";
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
	persistAgentModel(
		agent: AgentConfig,
		change: AgentModelFileChange,
	): AgentModelFileResult | Promise<AgentModelFileResult>;
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
const GLOBAL_SCOPE_LABEL = "User agent file (global)";
const SCOPE_CHOICES = [SESSION_SCOPE_LABEL, GLOBAL_SCOPE_LABEL] as const;

type ExtensionMode = "tui" | "rpc" | "json" | "print";

function errorWithUsage(message: string): ParsedAgentModelCommand {
	return { kind: "error", message: `${message}\n\n${USAGE}` };
}

/**
 * 1000000 -> "1M", 1234567 -> "1.2M", 1500000 -> "1.5M", 3500000 -> "3.5M",
 * 1050000 -> "1M" (1.05 floored to tenths = 1.0, trailing ".0" trimmed),
 * 128000 -> "128K", 8500 -> "8.5K", 8192 -> "8K", 900 -> "900". MILLION-scale
 * values are floored to one decimal place then have a trailing ".0" trimmed,
 * so capacity is never overstated. The K branch floors to an integer (an exact
 * half X.5 keeps one decimal). Non-finite or <= 0 -> "".
 */
export function formatTokenLimit(limit: number): string {
	if (!Number.isFinite(limit) || limit <= 0) {
		return "";
	}
	if (limit >= 1_000_000) {
		return formatMillion(limit / 1_000_000);
	}
	if (limit >= 1_000) {
		return formatScaled(limit / 1_000, "K");
	}
	return String(limit);
}

/**
 * Render a MILLION-scale value, flooring to one decimal place and trimming a
 * trailing ".0" so integral values render without a decimal. Flooring to tenths
 * guarantees the result never exceeds the true value.
 */
function formatMillion(units: number): string {
	const floored = Math.floor(units * 10) / 10;
	const trimmed = floored.toFixed(1).replace(/\.0$/, "");
	return `${trimmed}M`;
}

/** Render a K-scale unit value, flooring messy fractions to avoid overstating. */
function formatScaled(units: number, suffix: string): string {
	if (units % 1 === 0) {
		return `${units}${suffix}`;
	}
	// Exact halves (X.5) keep one decimal; anything else floors to an integer.
	if ((units * 2) % 1 === 0) {
		return `${units.toFixed(1)}${suffix}`;
	}
	return `${Math.floor(units)}${suffix}`;
}

/** Build the picker item list, including the pinned "agent default" entry. */
export function buildModelItems(models: readonly Model<Api>[]): SelectItem[] {
	return [
		{
			value: DEFAULT_MODEL_VALUE,
			label: DEFAULT_REASONING_LABEL,
			description: "Clear the selected scope's model setting",
		},
		...models.map((model) => {
			const parts = [model.name];
			const context = formatTokenLimit(model.contextWindow);
			if (context) {
				parts.push(`${context} ctx`);
			}
			const output = formatTokenLimit(model.maxTokens);
			if (output) {
				parts.push(`${output} out`);
			}
			return {
				value: `${model.provider}/${model.id}`,
				label: `${model.provider}/${model.id}`,
				description: parts.filter(Boolean).join(" · "),
			};
		}),
	];
}

/**
 * Fuzzy-filter picker items. The pinned default entry is always kept first so
 * an override can be cleared regardless of the query. Blank query returns all.
 */
export function filterModelItems(
	items: readonly SelectItem[],
	query: string,
): SelectItem[] {
	const pinned = items.filter((item) => item.value === DEFAULT_MODEL_VALUE);
	const rest = items.filter((item) => item.value !== DEFAULT_MODEL_VALUE);
	if (query.trim() === "") {
		return [...pinned, ...rest];
	}
	return [
		...pinned,
		...fuzzyFilter(rest, query, (item) => `${item.value} ${item.description ?? ""}`),
	];
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
		"In headless modes, configure the user agent frontmatter or, when invocation overrides are enabled, pass model and thinkingLevel to the subagent tool instead."
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
	savedPath?: string,
): string {
	return [
		`Agent "${agentName}" updated:`,
		`model ${effective.model ?? "agent default"};`,
		`reasoning ${effective.thinkingLevel ?? "agent/model default"};`,
		`source ${effective.source};`,
		`scope ${scopeLabel(scope)} (${scope}).`,
		...(savedPath === undefined ? [] : [`Saved ${savedPath}.`]),
	].join(" ");
}

function effectiveConfigForSessionChange(
	agent: AgentConfig,
	override: AgentModelOverride | undefined,
	ctx: ExtensionCommandContext,
	deps: AgentModelCommandDeps,
): EffectiveConfigOutcome {
	const session = deps.getSessionOverrides();
	const globalLoad = deps.loadGlobal();

	// Session-scope writes tolerate a corrupt legacy global file: ignore its
	// defaults and surface the problem as a non-fatal warning after the write.
	const global = globalLoad.error !== undefined ? {} : globalLoad.config;
	const nextSession = withOverride(session, agent.name, override);
	const effective = deps.buildEffectiveConfig(agent, {
		session: nextSession[agent.name],
		global: global[agent.name],
		parent: deps.parentFor(ctx),
	});
	return { effective, globalError: globalLoad.error };
}

function legacyGlobalOverrideError(
	agent: AgentConfig,
	globalLoad: LoadResult,
): string | undefined {
	if (globalLoad.error !== undefined) return globalLoad.error;
	if (!Object.prototype.hasOwnProperty.call(globalLoad.config, agent.name)) {
		return undefined;
	}
	return [
		`Agent "${agent.name}" still has a legacy override in ${globalLoad.path}.`,
		"That override would mask the agent frontmatter.",
		`Move or remove the "${agent.name}" entry from the JSON file, then retry /agent-model.`,
	].join(" ");
}

async function persistChange(
	agent: AgentConfig,
	scope: AgentModelScope,
	override: AgentModelOverride | undefined,
	ctx: ExtensionCommandContext,
	deps: AgentModelCommandDeps,
): Promise<void> {
	if (scope === "session") {
		const { effective, globalError } = effectiveConfigForSessionChange(
			agent,
			override,
			ctx,
			deps,
		);
		await deps.setSessionOverride(agent.name, override);
		ctx.ui.notify(successMessage(agent.name, scope, effective), "info");

		if (globalError !== undefined) {
			ctx.ui.notify(
				`Warning: the legacy global subagent model config is unreadable (${globalError}). The session override was applied, but legacy defaults were ignored. Run \`/agent-model global reset --force\` to repair the legacy config.`,
				"warning",
			);
		}
		return;
	}

	const globalLoad = deps.loadGlobal();
	const legacyError = legacyGlobalOverrideError(agent, globalLoad);
	if (legacyError !== undefined) throw new Error(legacyError);
	if (agent.source !== "user") {
		throw new Error(
			`Agent "${agent.name}" is ${agent.source}-source. Global model changes edit an existing user agent file; create a user-owned copy first.`,
		);
	}
	if (override !== undefined && override.model === undefined) {
		throw new Error("Internal invariant violated: a global model change has no model");
	}

	const change: AgentModelFileChange = override === undefined
		? { model: undefined }
		: {
				model: override.model!,
				...(override.thinkingLevel === undefined
					? {}
					: { thinkingLevel: override.thinkingLevel }),
			};
	const saved = await deps.persistAgentModel(agent, change);
	const session = deps.getSessionOverrides();
	const effective = deps.buildEffectiveConfig(saved.config, {
		session: session[agent.name],
		parent: deps.parentFor(ctx),
	});
	ctx.ui.notify(
		successMessage(agent.name, scope, effective, saved.path),
		"info",
	);
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

/**
 * Keys that Input consumes by moving the cursor without changing the text.
 * These must NOT be forwarded to SelectList after Input ignores them, or they
 * would double-navigate. The `cursor` field is private in both pi-tui SDKs
 * (0.56.1 and 0.83.0), so cursor movement cannot be detected via state
 * comparison alone — only value changes can. KeyId literals below are verified
 * present in both SDKs' keys.d.ts, and the bindings resolve to these actions in
 * both Input implementations:
 *   left / ctrl+b      -> cursorLeft
 *   right / ctrl+f     -> cursorRight
 *   home / ctrl+a      -> cursorLineStart
 *   end / ctrl+e       -> cursorLineEnd
 *   alt+left / ctrl+left / alt+b -> cursorWordLeft
 *   alt+right / ctrl+right / alt+f -> cursorWordRight
 */
function isCursorOnlyKey(data: string): boolean {
	return (
		matchesKey(data, "left") ||
		matchesKey(data, "right") ||
		matchesKey(data, "home") ||
		matchesKey(data, "end") ||
		matchesKey(data, "ctrl+a") ||
		matchesKey(data, "ctrl+b") ||
		matchesKey(data, "ctrl+e") ||
		matchesKey(data, "ctrl+f") ||
		matchesKey(data, "alt+left") ||
		matchesKey(data, "ctrl+left") ||
		matchesKey(data, "alt+b") ||
		matchesKey(data, "alt+right") ||
		matchesKey(data, "ctrl+right") ||
		matchesKey(data, "alt+f")
	);
}

async function selectModel(
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) =>
		`${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
	);
	const items = buildModelItems(models);

	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		// items always contains the pinned default entry, so this is >= 1.
		const maxVisible = Math.max(1, Math.min(items.length, 12));
		const container = new Container();
		const header = new Text("", 0, 0);
		const search = new Input();
		search.focused = true;
		const hint = new Text(
			theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc cancel"),
			0,
			0,
		);
		// SelectList has no setItems and Container has no insert-at-index, so a
		// query change rebuilds the list and re-adds all children in order. The
		// theme is a single shared const so the five callbacks are not duplicated.
		const listTheme: SelectListTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};
		let lastQuery = "";

		// SelectList has no setItems and Container has no insert-at-index, so a
		// query change rebuilds the list and re-adds all children in order.
		const mount = (filtered: SelectItem[]): SelectList => {
			const next = new SelectList(filtered, maxVisible, listTheme);
			next.onSelect = (item) => done(item.value);
			next.onCancel = () => done(undefined);
			header.setText(
				theme.fg(
					"accent",
					theme.bold(`Choose a model (${filtered.length}/${items.length})`),
				),
			);
			container.clear();
			container.addChild(header);
			container.addChild(search);
			container.addChild(next);
			container.addChild(hint);
			// filterModelItems always pins the "Use agent default" entry at index
			// 0, and each rebuilt SelectList resets its selection to 0. When a
			// query is active, jump to the first real match so Enter picks the
			// best result rather than the pinned default.
			const topMatch = filtered.findIndex(
				(item) => item.value !== DEFAULT_MODEL_VALUE,
			);
			if (lastQuery.trim() !== "" && topMatch > 0) {
				next.setSelectedIndex(topMatch);
			}
			return next;
		};
		let selectList = mount(items);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				// matchesKey + literal KeyIds exist with identical semantics in both
				// the dev SDK (0.56.1) and host SDK (0.83.0); getKeybindings does not
				// exist in the dev SDK — do not use it here. The `_kb` param is
				// intentionally unused: the two SDKs expose incompatible
				// keybinding registries, so we route explicitly and fall back to
				// SelectList's own SDK-native registry for user-remapped actions.
				//
				// Search owns ALL text entry. Pi enables the Kitty keyboard
				// protocol, so on a Kitty-capable terminal a plain "a" arrives as a
				// CSI-u escape sequence containing ESC; Input decodes it internally.
				// Bracketed paste is likewise decoded by Input. Classifying keys as
				// "printable" ourselves would break both, so instead we let Input
				// try first and forward only what it did not consume.
				//
				// Consequence: a select action remapped to a PRINTABLE key (e.g.
				// select-down -> "j") will type into the search box instead of
				// navigating, because search owns printable input.
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					done(undefined);
				} else if (
					matchesKey(data, "up") ||
					matchesKey(data, "down") ||
					matchesKey(data, "pageUp") ||
					matchesKey(data, "pageDown") ||
					matchesKey(data, "enter")
				) {
					selectList.handleInput(data);
				} else {
					// Input owns all text entry, including Kitty CSI-u printables and
					// bracketed paste, which it decodes internally. Only keys it did
					// not consume are offered to the list, so user-remapped select
					// actions still navigate. The `cursor` field is private in both
					// SDKs, so cursor-only moves (left/right/home/end/ctrl+a…) are
					// detected via an explicit guard rather than state comparison.
					const before = search.getValue();
					search.handleInput(data);
					const after = search.getValue();
					if (after !== before) {
						lastQuery = after;
						selectList = mount(filterModelItems(items, after));
					} else if (!isCursorOnlyKey(data)) {
						// Input ignored it entirely — might be a remapped select
						// action. SelectList resolves it via its own SDK-native
						// keybindings registry; safe no-op otherwise.
						selectList.handleInput(data);
					}
				}
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
			`Warning: the legacy global subagent model config is unreadable (${globalLoad.error}). Legacy defaults will be ignored for this selection. Run \`/agent-model global reset --force\` to repair the legacy config.`,
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
			"Choose a subagent model and reasoning level for this session or persist it in user-agent frontmatter",
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
						"Legacy global subagent model configuration reset.",
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
