import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { AgentConfig } from "./agents.js";

export type JsonSchema = Record<string, unknown>;

export interface ValidationIssue {
	path: string;
	message: string;
	keyword?: string;
	params?: Record<string, unknown>;
}

export function normalizeParametersSchema(raw: unknown): { schema?: JsonSchema; error?: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { error: "parameters must be an object schema" };
	}
	const schema = raw as JsonSchema;
	if (schema.type !== "object") {
		return { error: "parameters top-level type must be 'object'" };
	}

	try {
		const tempAjv = new Ajv({ strict: false, allErrors: true });
		addFormats(tempAjv);
		tempAjv.compile(schema);
	} catch (err: any) {
		return { error: `invalid JSON Schema: ${err.message}` };
	}

	return { schema };
}

export function validateAgentInput(schema: JsonSchema, input: unknown): ValidationIssue[] {
	const tempAjv = new Ajv({ strict: false, allErrors: true });
	addFormats(tempAjv);
	const validate = tempAjv.compile(schema);
	const valid = validate(input);
	if (valid) return [];

	return (validate.errors || []).map((err) => ({
		path: err.instancePath || "/",
		message: err.message || "Invalid input",
		keyword: err.keyword,
		params: err.params,
	}));
}

export function summarizeParameters(schema: JsonSchema): { required: string[]; optional: string[]; properties: string[] } {
	const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
	const props = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
	const optional = props.filter((p) => !required.includes(p));
	return { required, optional, properties: props };
}

/**
 * Build an example input object from a JSON Schema.
 *
 * Per-property value precedence:
 *   1. `default`          — if the property declares a default, use it
 *   2. first `examples`   — if the property has an examples array, use the first entry
 *   3. first `enum`        — if the property has an enum array, use the first entry
 *   4. typed placeholder   — fall back to a value based on the property type
 *
 * Outside this precedence the existing typed-placeholder behavior is preserved:
 * objects become `{}`, arrays become `[]`, etc.
 */
export function buildExampleInput(schema: JsonSchema): unknown {
	const props =
		schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, any>) : {};
	const example: Record<string, unknown> = {};
	for (const [key, prop] of Object.entries(props)) {
		example[key] = buildExampleValue(prop);
	}
	return example;
}

function buildExampleValue(prop: any): unknown {
	if (prop && prop.default !== undefined) return prop.default;
	if (prop && Array.isArray(prop.examples) && prop.examples.length > 0) return prop.examples[0];
	if (prop && Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];

	// typed placeholder (existing behavior)
	if (prop.type === "string") return "example";
	else if (prop.type === "integer" || prop.type === "number") return 0;
	else if (prop.type === "boolean") return true;
	else if (prop.type === "array") return [];
	else if (prop.type === "object") return {};
	else return null;
}

export function agentAllowsFreeform(agent: { parameters?: JsonSchema; allowFreeform?: boolean }): boolean {
	if (agent.allowFreeform !== undefined) return agent.allowFreeform;
	return !agent.parameters;
}

export function agentAllowsRuntimeTools(agent: { parameters?: JsonSchema; allowRuntimeTools?: boolean }): boolean {
	if (agent.allowRuntimeTools !== undefined) return agent.allowRuntimeTools;
	return !agent.parameters;
}

type AgentLike = AgentConfig;

export function buildCompactAgentInfo(agent: AgentLike): Record<string, unknown> {
	const isParameterized = !!agent.parameters;
	const allowFreeform = agentAllowsFreeform(agent);

	const accepts = {
		task: allowFreeform,
		input: isParameterized,
	};

	const info: Record<string, unknown> = {
		name: agent.name,
		description: agent.description,
		source: agent.source,
		mode: isParameterized ? "parameterized" : "freeform",
		accepts,
	};

	if (isParameterized) {
		const summary = summarizeParameters(agent.parameters!);
		info.required = summary.required;
		if (summary.optional.length > 0) {
			info.optional = summary.optional;
		}
		info.next = `describe_agent({ agent: "${agent.name}" })`;
	}

	return info;
}

export function buildFullAgentContract(agent: AgentLike): Record<string, unknown> {
	const isParameterized = !!agent.parameters;
	const allowFreeform = agentAllowsFreeform(agent);
	const allowRuntimeTools = agentAllowsRuntimeTools(agent);

	const info: Record<string, unknown> = {
		name: agent.name,
		description: agent.description,
		source: agent.source,
		mode: isParameterized ? "parameterized" : "freeform",
		allowFreeform,
		allowRuntimeTools,
	};

	if (agent.tools !== undefined) info.tools = agent.tools;
	if (agent.extensions) info.extensions = agent.extensions;
	if (agent.model) info.model = agent.model;
	if (agent.inputInstructions) info.inputInstructions = agent.inputInstructions;
	if (agent.parameters) info.parameters = agent.parameters;
	if (agent.systemPromptMode !== undefined) info.systemPromptMode = agent.systemPromptMode;
	if (agent.noSkills !== undefined) info.noSkills = agent.noSkills;
	if (agent.noPromptTemplates !== undefined) info.noPromptTemplates = agent.noPromptTemplates;
	if (agent.noContextFiles !== undefined) info.noContextFiles = agent.noContextFiles;

	info.examples = {};
	if (allowFreeform) {
		(info.examples as any).freeform = `subagent({ agent: "${agent.name}", task: "..." })`;
	}
	if (isParameterized) {
		const exampleInput = buildExampleInput(agent.parameters!);
		(info.examples as any).parameterized = `subagent({ agent: "${agent.name}", input: ${JSON.stringify(exampleInput)} })`;
	}

	return info;
}

export function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export function truncateForDisplay(text: string, max: number = 300): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 3) + "...";
}
