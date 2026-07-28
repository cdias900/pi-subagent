/**
 * Schema-gate regression coverage for resolveInvocation.
 *
 * These tests exercise the public `resolveInvocation` function (and the
 * exported `displayInputSummary` helper) to verify every schema-gate branch:
 *
 *   - parameterized agent rejects task-only by default
 *   - valid structured input is accepted and produces a typed prompt
 *   - schema validation errors are surfaced with issue details
 *   - allowFreeform:true lets a parameterized agent accept free-form tasks
 *   - legacy (non-parameterized) agents default to freeform behavior
 *   - allowRuntimeTools defaults to false for parameterized agents
 *   - allowRuntimeTools explicit true/false is honored
 *   - runtime tools (mcps/extensions) are rejected/accepted accordingly
 *   - task+input exclusivity (both, or neither) is enforced
 *   - input for a freeform agent is rejected
 *   - unknown agent is rejected
 *   - oversized input is rejected
 *   - freeform legacy task prompt construction is unchanged
 *   - previousOutput placeholder expansion works for both task and input
 *   - passthrough fields (cwd, saveAs, mcps, extensions) are preserved
 *
 * No source files are modified — this file only imports and tests public APIs.
 */
import { describe, it, expect } from "vitest";
import { resolveInvocation, displayInputSummary } from "./invocation.js";
import type { InvocationSpec } from "./invocation.js";
import type { AgentConfig } from "./agents.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a minimal AgentConfig with sensible defaults. */
function makeAgent(overrides: Partial<AgentConfig> & { name?: string }): AgentConfig {
	return {
		name: overrides.name ?? "test-agent",
		description: "A test agent.",
		systemPrompt: "system prompt body",
		source: overrides.source ?? "bundled",
		filePath: "/tmp/test-agent.md",
		...overrides,
	} as AgentConfig;
}

/** A simple object schema with one required string property. */
const SIMPLE_SCHEMA: AgentConfig["parameters"] = {
	type: "object",
	required: ["name"],
	properties: {
		name: { type: "string" },
		count: { type: "integer" },
	},
};

/** Build a parameterized agent (has parameters, no allowFreeform/allowRuntimeTools). */
function makeParameterizedAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return makeAgent({
		name: "param-agent",
		parameters: SIMPLE_SCHEMA,
		...overrides,
	});
}

/** Build a legacy/freeform agent (no parameters). */
function makeLegacyAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return makeAgent({
		name: "legacy-agent",
		...overrides,
	});
}

/** Call resolveInvocation with a single-agent list. */
function invoke(agents: AgentConfig[], spec: InvocationSpec) {
	return resolveInvocation({ agents, spec });
}

/** Expect resolveInvocation to throw with a message containing all substrings. */
function expectThrow(agents: AgentConfig[], spec: InvocationSpec, ...substrings: string[]) {
	expect(() => invoke(agents, spec)).toThrow();
	try {
		invoke(agents, spec);
	} catch (err: any) {
		for (const sub of substrings) {
			expect(err.message).toContain(sub);
		}
	}
}

// ── Unknown agent ──────────────────────────────────────────────────────

describe("resolveInvocation — unknown agent", () => {
	it("throws for an agent name not in the list", () => {
		const agents = [makeLegacyAgent()];
		expectThrow([agents[0]], { agent: "nonexistent", task: "do something" }, "Unknown agent", "nonexistent");
	});

	it("error message lists available agents", () => {
		const agents = [makeLegacyAgent({ name: "alpha", description: "Alpha agent" })];
		try {
			invoke(agents, { agent: "missing", task: "x" });
		} catch (err: any) {
			expect(err.message).toContain("Available agents:");
			expect(err.message).toContain("alpha");
		}
	});
});

// ── Task/input exclusivity ─────────────────────────────────────────────

describe("resolveInvocation — task/input exclusivity", () => {
	const agent = makeLegacyAgent();

	it("throws when both task and input are provided", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, task: "do thing", input: { name: "x" } },
			"exactly one",
			"task",
			"input",
		);
	});

	it("throws when neither task nor input is provided", () => {
		expectThrow([agent], { agent: agent.name }, "exactly one");
	});

	it("error message references the agent contract", () => {
		try {
			invoke([agent], { agent: agent.name });
		} catch (err: any) {
			expect(err.message).toContain(agent.name);
			expect(err.message).toContain("describe_agent");
		}
	});
});

// ── Parameterized agent: task-only rejection ───────────────────────────

describe("resolveInvocation — parameterized agent rejects task-only by default", () => {
	const agent = makeParameterizedAgent();

	it("throws when a parameterized agent is invoked with task only", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, task: "do something" },
			"parameterized",
			"does not accept free-form",
			"task",
		);
	});

	it("error message includes an example input matching the schema", () => {
		try {
			invoke([agent], { agent: agent.name, task: "do something" });
		} catch (err: any) {
			// buildExampleInput produces { name: "example", count: 0 }
			expect(err.message).toContain('"name"');
			expect(err.message).toContain("allowFreeform");
		}
	});

	it("error message suggests setting allowFreeform: true", () => {
		try {
			invoke([agent], { agent: agent.name, task: "do something" });
		} catch (err: any) {
			expect(err.message).toContain("allowFreeform: true");
		}
	});
});

// ── Parameterized agent: valid structured input ────────────────────────

describe("resolveInvocation — valid structured input acceptance", () => {
	const agent = makeParameterizedAgent();

	it("accepts valid input and returns promptKind 'input'", () => {
		const result = invoke([agent], { agent: agent.name, input: { name: "alice" } });
		expect(result.promptKind).toBe("input");
		expect(result.agentName).toBe(agent.name);
		expect(result.input).toEqual({ name: "alice" });
	});

	it("constructs a typed prompt containing the untrusted-data warning", () => {
		const result = invoke([agent], { agent: agent.name, input: { name: "alice" } });
		expect(result.prompt).toContain("parameterized subagent interface");
		expect(result.prompt).toContain("untrusted data");
	});

	it("prompt includes the input JSON in a fenced code block", () => {
		const result = invoke([agent], { agent: agent.name, input: { name: "alice", count: 3 } });
		expect(result.prompt).toContain("```json");
		expect(result.prompt).toContain('"name": "alice"');
		expect(result.prompt).toContain('"count": 3');
	});

	it("prompt includes inputInstructions when the agent defines them", () => {
		const agentWithInstr = makeParameterizedAgent({ inputInstructions: "Process the name field carefully." });
		const result = invoke([agentWithInstr], { agent: agentWithInstr.name, input: { name: "bob" } });
		expect(result.prompt).toContain("## Input Instructions");
		expect(result.prompt).toContain("Process the name field carefully.");
	});

	it("prompt omits Input Instructions section when agent has none", () => {
		const result = invoke([agent], { agent: agent.name, input: { name: "alice" } });
		expect(result.prompt).not.toContain("## Input Instructions");
	});

	it("produces a display summary from the input", () => {
		const result = invoke([agent], { agent: agent.name, input: { name: "alice", count: 42 } });
		expect(result.display).toContain("name: alice");
		expect(result.display).toContain("count: 42");
	});

	it("accepts input with optional fields omitted", () => {
		const result = invoke([agent], { agent: agent.name, input: { name: "only-required" } });
		expect(result.promptKind).toBe("input");
		expect(result.input).toEqual({ name: "only-required" });
	});
});

// ── Schema validation errors ───────────────────────────────────────────

describe("resolveInvocation — schema validation errors", () => {
	const agent = makeParameterizedAgent();

	it("rejects input missing a required field", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: { count: 5 } },
			"Input validation failed",
			agent.name,
		);
	});

	it("validation error includes the issue path", () => {
		try {
			invoke([agent], { agent: agent.name, input: { count: 5 } });
		} catch (err: any) {
			// AJV reports required errors at root "/" or at the property path
			expect(err.message).toContain("must have required property");
			expect(err.message).toContain("name");
		}
	});

	it("rejects input with wrong type for a field", () => {
		try {
			invoke([agent], { agent: agent.name, input: { name: 123 } });
		} catch (err: any) {
			expect(err.message).toContain("Input validation failed");
			expect(err.message).toContain("/name");
		}
	});

	it("validation error includes the provided input and an example", () => {
		try {
			invoke([agent], { agent: agent.name, input: { name: 123 } });
		} catch (err: any) {
			expect(err.message).toContain("Provided input:");
			expect(err.message).toContain("Example input:");
			expect(err.message).toContain("Parameter schema:");
		}
	});

	it("rejects input that is not an object", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: "not an object" },
			"Input validation failed",
		);
	});

	it("rejects input that is null", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: null },
			"Input validation failed",
		);
	});

	it("validation error suggests checking describe_agent", () => {
		try {
			invoke([agent], { agent: agent.name, input: {} });
		} catch (err: any) {
			expect(err.message).toContain("describe_agent");
		}
	});
});

// ── allowFreeform: true acceptance ─────────────────────────────────────

describe("resolveInvocation — allowFreeform:true lets parameterized agent accept task", () => {
	const agent = makeParameterizedAgent({ allowFreeform: true });

	it("accepts a free-form task when allowFreeform is true", () => {
		const result = invoke([agent], { agent: agent.name, task: "do something freeform" });
		expect(result.promptKind).toBe("task");
		expect(result.task).toBe("do something freeform");
	});

	it("constructs a 'Task: ...' prompt for freeform invocation", () => {
		const result = invoke([agent], { agent: agent.name, task: "freeform task text" });
		expect(result.prompt).toBe("Task: freeform task text");
	});

	it("still accepts structured input when allowFreeform is true", () => {
		const result = invoke([agent], { agent: agent.name, input: { name: "structured" } });
		expect(result.promptKind).toBe("input");
		expect(result.input).toEqual({ name: "structured" });
	});
});

// ── Default allowFreeform for legacy agents ────────────────────────────

describe("resolveInvocation — default allowFreeform for legacy agents", () => {
	const agent = makeLegacyAgent();

	it("legacy agent (no parameters) accepts a task by default", () => {
		const result = invoke([agent], { agent: agent.name, task: "legacy task" });
		expect(result.promptKind).toBe("task");
		expect(result.prompt).toBe("Task: legacy task");
	});

	it("legacy agent rejects structured input", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: { name: "x" } },
			"freeform agent",
			"does not accept structured",
			"input",
		);
	});

	it("legacy input error suggests replacing input with task", () => {
		try {
			invoke([agent], { agent: agent.name, input: { name: "x" } });
		} catch (err: any) {
			expect(err.message).toContain("Replace");
			expect(err.message).toContain("task");
		}
	});
});

// ── allowRuntimeTools defaults ─────────────────────────────────────────

describe("resolveInvocation — allowRuntimeTools default false for parameterized agents", () => {
	const agent = makeParameterizedAgent(); // no allowRuntimeTools field

	it("rejects mcps by default", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: { name: "x" }, mcps: ["some-mcp"] },
			"does not allow runtime",
			"extensions",
			"mcps",
		);
	});

	it("rejects extensions by default", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: { name: "x" }, extensions: ["some-ext"] },
			"does not allow runtime",
		);
	});

	it("rejects both mcps and extensions by default", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: { name: "x" }, mcps: ["m1"], extensions: ["e1"] },
			"does not allow runtime",
		);
	});

	it("error message suggests setting allowRuntimeTools: true", () => {
		try {
			invoke([agent], { agent: agent.name, input: { name: "x" }, extensions: ["e1"] });
		} catch (err: any) {
			expect(err.message).toContain("allowRuntimeTools: true");
		}
	});

	it("accepts invocation with empty mcps/extensions arrays (no runtime tools)", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: { name: "x" },
			mcps: [],
			extensions: [],
		});
		expect(result.promptKind).toBe("input");
	});

	it("accepts invocation with no mcps/extensions at all", () => {
		const result = invoke([agent], { agent: agent.name, input: { name: "x" } });
		expect(result.promptKind).toBe("input");
		expect(result.mcps).toBeUndefined();
		expect(result.extensions).toBeUndefined();
	});
});

describe("resolveInvocation — allowRuntimeTools explicit true", () => {
	const agent = makeParameterizedAgent({ allowRuntimeTools: true });

	it("accepts mcps when allowRuntimeTools is true", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: { name: "x" },
			mcps: ["some-mcp"],
		});
		expect(result.promptKind).toBe("input");
		expect(result.mcps).toEqual(["some-mcp"]);
	});

	it("accepts extensions when allowRuntimeTools is true", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: { name: "x" },
			extensions: ["some-ext"],
		});
		expect(result.promptKind).toBe("input");
		expect(result.extensions).toEqual(["some-ext"]);
	});

	it("accepts both mcps and extensions when allowRuntimeTools is true", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: { name: "x" },
			mcps: ["m1"],
			extensions: ["e1"],
		});
		expect(result.mcps).toEqual(["m1"]);
		expect(result.extensions).toEqual(["e1"]);
	});
});

describe("resolveInvocation — allowRuntimeTools explicit false", () => {
	const agent = makeParameterizedAgent({ allowRuntimeTools: false });

	it("rejects mcps when allowRuntimeTools is explicitly false", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: { name: "x" }, mcps: ["m1"] },
			"does not allow runtime",
		);
	});

	it("rejects extensions when allowRuntimeTools is explicitly false", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: { name: "x" }, extensions: ["e1"] },
			"does not allow runtime",
		);
	});
});

// ── Legacy agents: runtime tools not restricted ────────────────────────

describe("resolveInvocation — legacy agents allow runtime tools by default", () => {
	const agent = makeLegacyAgent();

	it("legacy agent accepts mcps without allowRuntimeTools field", () => {
		const result = invoke([agent], { agent: agent.name, task: "do thing", mcps: ["m1"] });
		expect(result.promptKind).toBe("task");
		expect(result.mcps).toEqual(["m1"]);
	});

	it("legacy agent accepts extensions without allowRuntimeTools field", () => {
		const result = invoke([agent], { agent: agent.name, task: "do thing", extensions: ["e1"] });
		expect(result.extensions).toEqual(["e1"]);
	});
});

// ── Freeform legacy behavior unchanged ─────────────────────────────────

describe("resolveInvocation — freeform legacy behavior unchanged", () => {
	const agent = makeLegacyAgent({ name: "legacy-freeform" });

	it("produces 'Task: <text>' prompt for a simple task", () => {
		const result = invoke([agent], { agent: agent.name, task: "simple task" });
		expect(result.prompt).toBe("Task: simple task");
		expect(result.promptKind).toBe("task");
		expect(result.display).toBe("simple task");
	});

	it("display is truncated for very long tasks", () => {
		const longTask = "x".repeat(500);
		const result = invoke([agent], { agent: agent.name, task: longTask });
		expect(result.display.length).toBeLessThanOrEqual(300);
		expect(result.display.endsWith("...")).toBe(true);
	});

	it("expands {previous} placeholder in task when previousOutput is provided", () => {
		const result = resolveInvocation({
			agents: [agent],
			spec: { agent: agent.name, task: "Review: {previous}" },
			previousOutput: "previous-result",
		});
		expect(result.prompt).toBe("Task: Review: previous-result");
	});

	it("display strips {previous} placeholder", () => {
		const result = resolveInvocation({
			agents: [agent],
			spec: { agent: agent.name, task: "Review: {previous}" },
			previousOutput: "previous-result",
		});
		expect(result.display).toBe("Review:");
	});
});

// ── Oversized input ────────────────────────────────────────────────────

describe("resolveInvocation — oversized input rejection", () => {
	const agent = makeParameterizedAgent();

	it("rejects input whose serialized form exceeds the maximum", () => {
		const hugeName = "x".repeat(21_000);
		expectThrow(
			[agent],
			{ agent: agent.name, input: { name: hugeName } },
			"exceeds maximum size",
		);
	});

	it("accepts input just under the size limit", () => {
		// serialized form of { name: "x"*19000 } is well under 20000
		const result = invoke([agent], { agent: agent.name, input: { name: "x".repeat(19_000) } });
		expect(result.promptKind).toBe("input");
	});
});

// ── previousOutput expansion in structured input ───────────────────────

describe("resolveInvocation — previousOutput expansion in structured input", () => {
	const agent = makeParameterizedAgent();

	it("expands {previous} inside string values of structured input", () => {
		const result = resolveInvocation({
			agents: [agent],
			spec: { agent: agent.name, input: { name: "prefix-{previous}-suffix" } },
			previousOutput: "RESULT",
		});
		expect(result.input).toEqual({ name: "prefix-RESULT-suffix" });
	});

	it("does not expand {previous} when previousOutput is undefined", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: { name: "literal-{previous}-text" },
		});
		expect(result.input).toEqual({ name: "literal-{previous}-text" });
	});
});

// ── Passthrough fields ─────────────────────────────────────────────────

describe("resolveInvocation — passthrough fields", () => {
	const agent = makeParameterizedAgent();

	it("preserves cwd and saveAs when no runtime tools are present", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: { name: "x" },
			cwd: "/some/cwd",
			saveAs: "output-name",
		});
		expect(result.cwd).toBe("/some/cwd");
		expect(result.saveAs).toBe("output-name");
	});

	it("preserves mcps and extensions when allowRuntimeTools is true", () => {
		const allowingAgent = makeParameterizedAgent({ allowRuntimeTools: true });
		const result = invoke([allowingAgent], {
			agent: allowingAgent.name,
			input: { name: "x" },
			cwd: "/cwd",
			saveAs: "out",
			mcps: ["m1", "m2"],
			extensions: ["e1"],
		});
		expect(result.cwd).toBe("/cwd");
		expect(result.saveAs).toBe("out");
		expect(result.mcps).toEqual(["m1", "m2"]);
		expect(result.extensions).toEqual(["e1"]);
	});

	it("preserves step and teamName when provided", () => {
		const result = resolveInvocation({
			agents: [agent],
			spec: { agent: agent.name, input: { name: "x" } },
			step: 2,
		});
		expect(result.step).toBe(2);
	});
});

// ── displayInputSummary ────────────────────────────────────────────────

describe("displayInputSummary", () => {
	it("returns string representation for primitives", () => {
		expect(displayInputSummary("hello")).toBe("hello");
		expect(displayInputSummary(42)).toBe("42");
		expect(displayInputSummary(true)).toBe("true");
	});

	it("returns '{}' for empty objects", () => {
		expect(displayInputSummary({})).toBe("{}");
	});

	it("summarizes flat object with primitive values", () => {
		expect(displayInputSummary({ name: "alice", count: 3 })).toBe("{ name: alice, count: 3 }");
	});

	it("summarizes array values as '[N items]'", () => {
		expect(displayInputSummary({ tags: ["a", "b", "c"] })).toBe("{ tags: [3 items] }");
	});

	it("summarizes nested object values as '{...}'", () => {
		expect(displayInputSummary({ meta: { inner: 1 } })).toBe("{ meta: {...} }");
	});

	it("truncates long primitive values to 30 chars with ellipsis", () => {
		const longVal = "x".repeat(50);
		const summary = displayInputSummary({ field: longVal });
		expect(summary).toContain("field: x");
		expect(summary).toContain("...");
		// truncated portion should be 27 chars + "..." (trailing space before } is part of summary format)
		const valPart = summary.match(/field: (.+?)\s*\}/)![1];
		expect(valPart.length).toBe(30); // 27 + "..."
	});

	it("handles null input", () => {
		expect(displayInputSummary(null)).toBe("null");
	});
});

// ── JSON-string input coercion ─────────────────────────────────────────

describe("resolveInvocation — JSON-string input coercion", () => {
	const agent = makeParameterizedAgent();

	it("accepts a stringified valid object and parses it into an object", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: JSON.stringify({ name: "alice", count: 3 }),
		});
		expect(result.promptKind).toBe("input");
		expect(result.input).toEqual({ name: "alice", count: 3 });
		expect(typeof result.input).toBe("object");
		expect(result.input).not.toBeNull();
	});

	it("typed prompt contains the parsed JSON values", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: JSON.stringify({ name: "alice", count: 3 }),
		});
		expect(result.prompt).toContain("```json");
		expect(result.prompt).toContain('"name": "alice"');
		expect(result.prompt).toContain('"count": 3');
	});

	it("malformed JSON string still throws 'Input validation failed' with 'must be object'", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: "{not valid json" },
			"Input validation failed",
		);
		try {
			invoke([agent], { agent: agent.name, input: "{not valid json" });
		} catch (err: any) {
			expect(err.message).toContain("must be object");
		}
	});

	it("stringified array '[1,2]' still throws a root type error", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: "[1,2]" },
			"Input validation failed",
		);
		try {
			invoke([agent], { agent: agent.name, input: "[1,2]" });
		} catch (err: any) {
			expect(err.message).toContain("must be object");
		}
	});

	it("stringified primitive '42' still throws a root type error", () => {
		expectThrow(
			[agent],
			{ agent: agent.name, input: "42" },
			"Input validation failed",
		);
		try {
			invoke([agent], { agent: agent.name, input: "42" });
		} catch (err: any) {
			expect(err.message).toContain("must be object");
		}
	});

	it("native object with a nested JSON-looking string value is NOT double-parsed", () => {
		const result = invoke([agent], {
			agent: agent.name,
			input: { name: '{"inner":"value"}' },
		});
		expect(result.input).toEqual({ name: '{"inner":"value"}' });
		expect(typeof (result.input as any).name).toBe("string");
	});

	it("parses stringified input containing {previous} before expanding placeholders", () => {
		const result = resolveInvocation({
			agents: [agent],
			spec: { agent: agent.name, input: '{"name":"{previous}"}' },
			previousOutput: 'hello "world"',
		});
		expect(result.input).toEqual({ name: 'hello "world"' });
		expect(typeof result.input).toBe("object");
	});

	it("preflight with stringified input containing {previous} suppresses correctly", () => {
		// Schema with a pattern constraint that {previous} violates, so the
		// preflight issue at /name should be suppressed (value is a string
		// containing {previous}).
		const patternAgent = makeParameterizedAgent({
			parameters: {
				type: "object",
				required: ["name"],
				properties: {
					name: { type: "string", pattern: "^[a-z]+$" },
				},
			},
		});
		const result = resolveInvocation({
			agents: [patternAgent],
			spec: { agent: patternAgent.name, input: '{"name":"{previous}"}' },
			isPreflight: true,
		});
		expect(result.promptKind).toBe("input");
		expect(result.input).toEqual({ name: "{previous}" });
	});
});
