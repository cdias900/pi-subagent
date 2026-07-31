export const CANONICAL_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type SubagentThinkingLevel =
	(typeof CANONICAL_THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is SubagentThinkingLevel {
	return CANONICAL_THINKING_LEVELS.some((level) => level === value);
}

export interface NormalizedModel {
	base: string;
	provider: string | undefined;
	modelId: string;
	thinkingLevel: SubagentThinkingLevel | undefined;
}

export function splitProviderModel(
	modelString: string,
): Pick<NormalizedModel, "provider" | "modelId"> {
	const slashIndex = modelString.indexOf("/");

	if (slashIndex === -1) {
		return { provider: undefined, modelId: modelString };
	}

	return {
		provider: modelString.slice(0, slashIndex),
		modelId: modelString.slice(slashIndex + 1),
	};
}

export function normalizeModelString(modelString: string): NormalizedModel {
	const { provider, modelId } = splitProviderModel(modelString);
	const suffixSeparatorIndex = modelId.lastIndexOf(":");

	if (suffixSeparatorIndex === -1) {
		return { base: modelString, provider, modelId, thinkingLevel: undefined };
	}

	const suffix = modelId.slice(suffixSeparatorIndex + 1);

	if (!isThinkingLevel(suffix)) {
		return { base: modelString, provider, modelId, thinkingLevel: undefined };
	}

	return {
		base: modelString.slice(0, modelString.length - suffix.length - 1),
		provider,
		modelId: modelId.slice(0, suffixSeparatorIndex),
		thinkingLevel: suffix,
	};
}
