import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	normalizeModelString,
	splitProviderModel,
	type SubagentThinkingLevel,
} from "./model-normalize.js";

export type ModelSource =
	| "task"
	| "invocation"
	| "session"
	| "global"
	| "frontmatter"
	| "parent";

export interface ModelLayer {
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	source: ModelSource;
}

export interface ResolvedModelConfig {
	model?: string;
	thinkingLevel?: SubagentThinkingLevel;
	modelSource: ModelSource;
	thinkingLevelSource?: ModelSource;
	source: ModelSource;
}

export function resolveModelLayers(input: {
	layers: (ModelLayer | undefined)[];
	parent?: {
		model?: string;
		thinkingLevel?: SubagentThinkingLevel;
	};
}): ResolvedModelConfig {
	const parentLayer: ModelLayer = {
		model: input.parent?.model,
		thinkingLevel: input.parent?.thinkingLevel,
		source: "parent",
	};
	let effectiveModel: string | undefined;
	let effectiveModelSource: ModelSource = "parent";
	let effectiveThinking: SubagentThinkingLevel | undefined;
	let effectiveThinkingSource: ModelSource | undefined;

	for (const layer of [parentLayer, ...input.layers]) {
		if (layer === undefined) continue;

		if (layer.model !== undefined && layer.model.trim() === "") {
			throw new Error(
				`model from source "${layer.source}" must not be empty or whitespace-only`,
			);
		}

		const normalized = layer.model
			? normalizeModelString(layer.model)
			: undefined;
		const layerLevel = layer.thinkingLevel ?? normalized?.thinkingLevel;

		if (normalized !== undefined) {
			effectiveModel = normalized.base;
			effectiveModelSource = layer.source;
			effectiveThinking = layerLevel;
			effectiveThinkingSource =
				layerLevel === undefined ? undefined : layer.source;
		} else if (layerLevel !== undefined) {
			effectiveThinking = layerLevel;
			effectiveThinkingSource = layer.source;
		}
	}

	const modelSource =
		effectiveModel === undefined ? "parent" : effectiveModelSource;
	const source =
		effectiveModel !== undefined && effectiveModelSource !== "parent"
			? effectiveModelSource
			: (effectiveThinkingSource ?? "parent");

	return {
		model: effectiveModel,
		thinkingLevel: effectiveThinking,
		modelSource,
		thinkingLevelSource: effectiveThinkingSource,
		source,
	};
}

export interface ModelCatalogPort {
	findExact(provider: string | undefined, id: string): Model<Api> | undefined;
	resolvePattern(pattern: string): Model<Api> | undefined;
	isAvailable(model: Model<Api>): boolean;
	supportedThinkingLevels(model: Model<Api>): SubagentThinkingLevel[];
}

export type ValidationResult =
	| { ok: true; model?: Model<Api> }
	| { ok: false; error: string };

function hasOnlySource(
	thinkingLevelSource: ModelSource | undefined,
	source: "frontmatter" | "parent",
): boolean {
	return thinkingLevelSource === undefined || thinkingLevelSource === source;
}

function unknownModelError(model: string, agentName: string): string {
	return `Model "${model}" is not available for agent "${agentName}". Run /agent-model ${agentName} to choose an available model.`;
}

function unauthenticatedModelError(model: string, agentName: string): string {
	return `Model "${model}" is unavailable or unauthenticated for agent "${agentName}". Run /agent-model ${agentName} to choose an available model.`;
}

function unsupportedLevelError(
	level: SubagentThinkingLevel,
	model: string,
	supported: readonly SubagentThinkingLevel[],
): string {
	return `Reasoning level "${level}" is not supported by "${model}". Supported: ${supported.join(", ")}.`;
}

export function validateResolvedModel(
	resolved: ResolvedModelConfig,
	port: ModelCatalogPort,
	opts: { agentName: string },
): ValidationResult {
	if (resolved.model === undefined) return { ok: true };

	const { provider, modelId } = splitProviderModel(resolved.model);
	const model =
		resolved.modelSource === "frontmatter"
			? (port.resolvePattern(resolved.model) ??
				port.findExact(provider, modelId))
			: port.findExact(provider, modelId);

	if (model === undefined) {
		if (
			resolved.modelSource === "frontmatter" &&
			hasOnlySource(resolved.thinkingLevelSource, "frontmatter")
		) {
			return { ok: true };
		}
		if (
			resolved.modelSource === "parent" &&
			hasOnlySource(resolved.thinkingLevelSource, "parent")
		) {
			return { ok: true };
		}

		return {
			ok: false,
			error: unknownModelError(resolved.model, opts.agentName),
		};
	}

	if (!port.isAvailable(model)) {
		if (
			resolved.modelSource === "parent" &&
			hasOnlySource(resolved.thinkingLevelSource, "parent")
		) {
			return { ok: true, model };
		}

		return {
			ok: false,
			error: unauthenticatedModelError(resolved.model, opts.agentName),
		};
	}

	if (resolved.thinkingLevel !== undefined) {
		const supported = port.supportedThinkingLevels(model);
		if (!supported.includes(resolved.thinkingLevel)) {
			return {
				ok: false,
				error: unsupportedLevelError(
					resolved.thinkingLevel,
					resolved.model,
					supported,
				),
			};
		}
	}

	return { ok: true, model };
}

export function getSupportedThinkingLevelsCompat(
	model: Model<Api>,
): SubagentThinkingLevel[] {
	return getSupportedThinkingLevels(model);
}
