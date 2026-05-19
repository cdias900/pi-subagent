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

export function buildExampleInput(schema: JsonSchema): unknown {
	const props =
		schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, any>) : {};
	const example: Record<string, unknown> = {};
	for (const [key, prop] of Object.entries(props)) {
		if (prop.type === "string") example[key] = "example";
		else if (prop.type === "integer" || prop.type === "number") example[key] = 0;
		else if (prop.type === "boolean") example[key] = true;
		else if (prop.type === "array") example[key] = [];
		else if (prop.type === "object") example[key] = {};
		else example[key] = null;
	}
	return example;
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

	if (agent.tools) info.tools = agent.tools;
	if (agent.extensions) info.extensions = agent.extensions;
	if (agent.model) info.model = agent.model;
	if (agent.inputInstructions) info.inputInstructions = agent.inputInstructions;
	if (agent.parameters) info.parameters = agent.parameters;

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
