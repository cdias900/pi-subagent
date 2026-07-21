import { describe, it, expect } from "vitest";
import {
	summarizeParameters,
	buildExampleInput,
	buildFullAgentContract,
	buildCompactAgentInfo,
} from "./parameters.js";
import type { AgentConfig } from "./agents.js";

/** Minimal helper to build an AgentConfig with required fields filled in. */
function makeAgent(overrides: Partial<AgentConfig> & { name?: string; description?: string }): AgentConfig {
	return {
		name: overrides.name ?? "test-agent",
		description: overrides.description ?? "A test agent.",
		systemPrompt: "system prompt body",
		source: overrides.source ?? "bundled",
		filePath: "/tmp/test-agent.md",
		...overrides,
	} as AgentConfig;
}

describe("buildExampleInput — per-property precedence", () => {
	it("uses `default` when present (highest precedence)", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string", default: "fallback-name" },
				count: { type: "integer", default: 42 },
			},
		};
		expect(buildExampleInput(schema)).toEqual({ name: "fallback-name", count: 42 });
	});

	it("uses first `examples` entry when no default", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string", examples: ["alice", "bob"] },
			},
		};
		expect(buildExampleInput(schema)).toEqual({ name: "alice" });
	});

	it("uses first `enum` entry when no default and no examples", () => {
		const schema = {
			type: "object",
			properties: {
				status: { type: "string", enum: ["active", "inactive"] },
			},
		};
		expect(buildExampleInput(schema)).toEqual({ status: "active" });
	});

	it("falls back to typed placeholder when no default/examples/enum", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				count: { type: "integer" },
				enabled: { type: "boolean" },
				tags: { type: "array" },
				meta: { type: "object" },
				unknown: { type: "custom" },
			},
		};
		expect(buildExampleInput(schema)).toEqual({
			name: "example",
			count: 0,
			enabled: true,
			tags: [],
			meta: {},
			unknown: null,
		});
	});

	it("default wins over examples and enum", () => {
		const schema = {
			type: "object",
			properties: {
				status: {
					type: "string",
					default: "default-val",
					examples: ["example-val"],
					enum: ["enum-val"],
				},
			},
		};
		expect(buildExampleInput(schema)).toEqual({ status: "default-val" });
	});

	it("examples wins over enum", () => {
		const schema = {
			type: "object",
			properties: {
				status: {
					type: "string",
					examples: ["example-val"],
					enum: ["enum-val"],
				},
			},
		};
		expect(buildExampleInput(schema)).toEqual({ status: "example-val" });
	});

	it("empty examples array falls through to enum", () => {
		const schema = {
			type: "object",
			properties: {
				status: { type: "string", examples: [], enum: ["enum-val"] },
			},
		};
		expect(buildExampleInput(schema)).toEqual({ status: "enum-val" });
	});

	it("empty enum array falls through to typed placeholder", () => {
		const schema = {
			type: "object",
			properties: {
				status: { type: "string", enum: [] },
			},
		};
		expect(buildExampleInput(schema)).toEqual({ status: "example" });
	});

	it("handles empty properties", () => {
		expect(buildExampleInput({ type: "object", properties: {} })).toEqual({});
		expect(buildExampleInput({ type: "object" })).toEqual({});
	});

	it("preserves nested object/array typed placeholder behavior", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: { inner: { type: "string" } },
				},
				list: { type: "array" },
			},
		};
		// nested object falls through to {} (no recursion — existing behavior)
		expect(buildExampleInput(schema)).toEqual({ nested: {}, list: [] });
	});
});

describe("buildFullAgentContract — tools exposure", () => {
	it("exposes explicit empty tools array", () => {
		const agent = makeAgent({ tools: [] });
		const contract = buildFullAgentContract(agent);
		expect(contract.tools).toEqual([]);
	});

	it("exposes non-empty tools array", () => {
		const agent = makeAgent({ tools: ["read", "bash"] });
		const contract = buildFullAgentContract(agent);
		expect(contract.tools).toEqual(["read", "bash"]);
	});

	it("omits tools when undefined", () => {
		const agent = makeAgent({});
		const contract = buildFullAgentContract(agent);
		expect(contract).not.toHaveProperty("tools");
	});
});

describe("buildFullAgentContract — new optional fields", () => {
	it("exposes systemPromptMode when defined", () => {
		const agent = makeAgent({ systemPromptMode: "append" } as any);
		const contract = buildFullAgentContract(agent);
		expect(contract.systemPromptMode).toBe("append");
	});

	it("exposes noSkills when defined as true", () => {
		const agent = makeAgent({ noSkills: true } as any);
		const contract = buildFullAgentContract(agent);
		expect(contract.noSkills).toBe(true);
	});

	it("exposes noSkills when defined as false", () => {
		const agent = makeAgent({ noSkills: false } as any);
		const contract = buildFullAgentContract(agent);
		expect(contract.noSkills).toBe(false);
	});

	it("exposes noPromptTemplates when defined", () => {
		const agent = makeAgent({ noPromptTemplates: true } as any);
		const contract = buildFullAgentContract(agent);
		expect(contract.noPromptTemplates).toBe(true);
	});

	it("exposes noContextFiles when defined", () => {
		const agent = makeAgent({ noContextFiles: true } as any);
		const contract = buildFullAgentContract(agent);
		expect(contract.noContextFiles).toBe(true);
	});

	it("does not invent values for legacy agents (all new fields omitted)", () => {
		const agent = makeAgent({});
		const contract = buildFullAgentContract(agent);
		expect(contract).not.toHaveProperty("systemPromptMode");
		expect(contract).not.toHaveProperty("noSkills");
		expect(contract).not.toHaveProperty("noPromptTemplates");
		expect(contract).not.toHaveProperty("noContextFiles");
	});
});

describe("buildFullAgentContract — legacy contract output", () => {
	it("produces expected base fields for a freeform legacy agent", () => {
		const agent = makeAgent({ name: "legacy", description: "Legacy agent" });
		const contract = buildFullAgentContract(agent);
		expect(contract).toEqual({
			name: "legacy",
			description: "Legacy agent",
			source: "bundled",
			mode: "freeform",
			allowFreeform: true,
			allowRuntimeTools: true,
			examples: {
				freeform: `subagent({ agent: "legacy", task: "..." })`,
			},
		});
	});

	it("produces parameterized example for a legacy agent with parameters", () => {
		const agent = makeAgent({
			name: "param-agent",
			parameters: {
				type: "object",
				required: ["name"],
				properties: {
					name: { type: "string", default: "default-name" },
					count: { type: "integer" },
				},
			},
		});
		const contract = buildFullAgentContract(agent);
		expect(contract.mode).toBe("parameterized");
		expect(contract.allowFreeform).toBe(false);
		expect(contract.allowRuntimeTools).toBe(false);
		expect(contract.parameters).toEqual(agent.parameters);
		expect((contract.examples as any).parameterized).toBe(
			`subagent({ agent: "param-agent", input: {"name":"default-name","count":0} })`,
		);
		expect((contract.examples as any).freeform).toBeUndefined();
	});

	it("omits extensions/model/inputInstructions when not set", () => {
		const agent = makeAgent({});
		const contract = buildFullAgentContract(agent);
		expect(contract).not.toHaveProperty("extensions");
		expect(contract).not.toHaveProperty("model");
		expect(contract).not.toHaveProperty("inputInstructions");
		expect(contract).not.toHaveProperty("parameters");
	});
});

describe("buildCompactAgentInfo — regression", () => {
	it("produces compact info for a freeform agent", () => {
		const agent = makeAgent({ name: "simple", description: "Simple" });
		const info = buildCompactAgentInfo(agent);
		expect(info).toEqual({
			name: "simple",
			description: "Simple",
			source: "bundled",
			mode: "freeform",
			accepts: { task: true, input: false },
		});
	});
});

describe("summarizeParameters — regression", () => {
	const schema = {
		type: "object",
		required: ["name", "count"],
		properties: {
			name: { type: "string" },
			count: { type: "integer" },
			enabled: { type: "boolean" },
			tags: { type: "array" },
		},
	};

	it("summarizes required, optional, and properties", () => {
		const summary = summarizeParameters(schema);
		expect(summary.required).toEqual(["name", "count"]);
		expect(summary.optional).toEqual(["enabled", "tags"]);
		expect(summary.properties).toEqual(["name", "count", "enabled", "tags"]);
	});
});
