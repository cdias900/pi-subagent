import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./agents.js";
import { resolveInvocation } from "./invocation.js";
import type { ResolvedModelConfig } from "./model-resolution.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "A test agent.",
		systemPrompt: "system prompt body",
		source: "bundled",
		filePath: "/tmp/test-agent.md",
		...overrides,
	};
}

describe("resolveInvocation model resolution", () => {
	it("resolves the frontmatter model when there is no other override", () => {
		const agent = makeAgent({ model: "anthropic/claude-sonnet:high" });

		const invocation = resolveInvocation({
			agents: [agent],
			spec: { agent: agent.name, task: "Review this change" },
		});

		expect(invocation.resolvedModel).toEqual({
			model: "anthropic/claude-sonnet",
			thinkingLevel: "high",
			modelSource: "frontmatter",
			thinkingLevelSource: "frontmatter",
			source: "frontmatter",
		});
	});

	it("inherits the parent model and reasoning for a model-less agent", () => {
		const agent = makeAgent();

		const invocation = resolveInvocation({
			agents: [agent],
			spec: { agent: agent.name, task: "Review this change" },
			modelResolution: {
				parent: { model: "openai/gpt-parent", thinkingLevel: "medium" },
			},
		});

		expect(invocation.resolvedModel).toEqual({
			model: "openai/gpt-parent",
			thinkingLevel: "medium",
			modelSource: "parent",
			thinkingLevelSource: "parent",
			source: "parent",
		});
	});

	it("uses the undefined parent defaults when no model or parent is supplied", () => {
		const agent = makeAgent();

		const invocation = resolveInvocation({
			agents: [agent],
			spec: { agent: agent.name, task: "Review this change" },
		});

		expect(invocation.resolvedModel).toEqual({
			model: undefined,
			thinkingLevel: undefined,
			modelSource: "parent",
			thinkingLevelSource: undefined,
			source: "parent",
		});
	});

	it.each([
		{
			name: "task over invocation",
			frontmatterModel: "provider/frontmatter:low",
			modelResolution: {
				parent: { model: "provider/parent", thinkingLevel: "minimal" as const },
				global: { model: "provider/global", thinkingLevel: "medium" as const },
				session: { model: "provider/session", thinkingLevel: "high" as const },
				invocation: { model: "provider/invocation", thinkingLevel: "xhigh" as const },
			},
			taskOverride: { model: "provider/task", thinkingLevel: "max" as const },
			expectedModel: "provider/task",
			expectedLevel: "max",
			expectedSource: "task",
		},
		{
			name: "invocation over session",
			frontmatterModel: "provider/frontmatter:low",
			modelResolution: {
				parent: { model: "provider/parent", thinkingLevel: "minimal" as const },
				global: { model: "provider/global", thinkingLevel: "medium" as const },
				session: { model: "provider/session", thinkingLevel: "high" as const },
				invocation: { model: "provider/invocation", thinkingLevel: "xhigh" as const },
			},
			taskOverride: {},
			expectedModel: "provider/invocation",
			expectedLevel: "xhigh",
			expectedSource: "invocation",
		},
		{
			name: "session over global",
			frontmatterModel: "provider/frontmatter:low",
			modelResolution: {
				parent: { model: "provider/parent", thinkingLevel: "minimal" as const },
				global: { model: "provider/global", thinkingLevel: "medium" as const },
				session: { model: "provider/session", thinkingLevel: "high" as const },
			},
			taskOverride: {},
			expectedModel: "provider/session",
			expectedLevel: "high",
			expectedSource: "session",
		},
		{
			name: "global over frontmatter",
			frontmatterModel: "provider/frontmatter:low",
			modelResolution: {
				parent: { model: "provider/parent", thinkingLevel: "minimal" as const },
				global: { model: "provider/global", thinkingLevel: "medium" as const },
			},
			taskOverride: {},
			expectedModel: "provider/global",
			expectedLevel: "medium",
			expectedSource: "global",
		},
		{
			name: "frontmatter over parent",
			frontmatterModel: "provider/frontmatter:low",
			modelResolution: {
				parent: { model: "provider/parent", thinkingLevel: "minimal" as const },
			},
			taskOverride: {},
			expectedModel: "provider/frontmatter",
			expectedLevel: "low",
			expectedSource: "frontmatter",
		},
		{
			name: "parent as the lowest layer",
			frontmatterModel: undefined,
			modelResolution: {
				parent: { model: "provider/parent", thinkingLevel: "minimal" as const },
			},
			taskOverride: {},
			expectedModel: "provider/parent",
			expectedLevel: "minimal",
			expectedSource: "parent",
		},
	])(
		"applies $name in task > invocation > session > global > frontmatter > parent order",
		({
			frontmatterModel,
			modelResolution,
			taskOverride,
			expectedModel,
			expectedLevel,
			expectedSource,
		}) => {
			const agent = makeAgent({ model: frontmatterModel });

			const invocation = resolveInvocation({
				agents: [agent],
				spec: {
					agent: agent.name,
					task: "Review this change",
					...taskOverride,
				},
				modelResolution,
			});

			expect(invocation.resolvedModel).toEqual({
				model: expectedModel,
				thinkingLevel: expectedLevel,
				modelSource: expectedSource,
				thinkingLevelSource: expectedSource,
				source: expectedSource,
			});
		},
	);

	it("keeps the effective model when the task supplies only thinking", () => {
		const agent = makeAgent({ model: "provider/frontmatter:low" });

		const invocation = resolveInvocation({
			agents: [agent],
			spec: {
				agent: agent.name,
				task: "Review this change",
				thinkingLevel: "max",
			},
			modelResolution: {
				global: { model: "provider/global", thinkingLevel: "medium" },
			},
		});

		expect(invocation.resolvedModel).toEqual({
			model: "provider/global",
			thinkingLevel: "max",
			modelSource: "global",
			thinkingLevelSource: "task",
			source: "global",
		});
	});

	it("resets lower-layer thinking when the task supplies only a model", () => {
		const agent = makeAgent({ model: "provider/frontmatter:low" });

		const invocation = resolveInvocation({
			agents: [agent],
			spec: {
				agent: agent.name,
				task: "Review this change",
				model: "provider/task",
			},
			modelResolution: {
				session: { thinkingLevel: "xhigh" },
			},
		});

		expect(invocation.resolvedModel).toEqual({
			model: "provider/task",
			thinkingLevel: undefined,
			modelSource: "task",
			thinkingLevelSource: undefined,
			source: "task",
		});
	});

	it("retains parent model source fields when the task supplies only thinking", () => {
		const agent = makeAgent();

		const invocation = resolveInvocation({
			agents: [agent],
			spec: {
				agent: agent.name,
				task: "Review this change",
				thinkingLevel: "high",
			},
			modelResolution: {
				parent: { model: "provider/parent", thinkingLevel: "low" },
			},
		});

		expect(invocation.resolvedModel).toEqual({
			model: "provider/parent",
			thinkingLevel: "high",
			modelSource: "parent",
			thinkingLevelSource: "task",
			source: "task",
		});
	});

	it("reuses a caller-supplied resolution by identity without skipping input handling", () => {
		const agent = makeAgent({
			parameters: {
				type: "object",
				required: ["value"],
				properties: { value: { type: "string" } },
			},
		});
		const resolvedModel: ResolvedModelConfig = {
			model: "provider/pre-resolved",
			thinkingLevel: "medium",
			modelSource: "session",
			thinkingLevelSource: "session",
			source: "session",
		};

		expect(() =>
			resolveInvocation({
				agents: [agent],
				spec: { agent: agent.name, input: { value: 42 }, model: "provider/task" },
				resolvedModel,
			}),
		).toThrow("Input validation failed");

		const invocation = resolveInvocation({
			agents: [agent],
			spec: {
				agent: agent.name,
				input: { value: "before-{previous}-after" },
				model: "provider/task",
				thinkingLevel: "max",
			},
			previousOutput: "expanded",
			modelResolution: {
				invocation: { model: "provider/invocation", thinkingLevel: "high" },
			},
			resolvedModel,
		});

		expect(invocation.resolvedModel).toBe(resolvedModel);
		expect(invocation.input).toEqual({ value: "before-expanded-after" });
		expect(invocation.prompt).toContain('"value": "before-expanded-after"');
		expect(invocation.task).toBeUndefined();
	});

	it("leaves the existing returned task and prompt fields unchanged", () => {
		const agent = makeAgent({ model: "provider/frontmatter" });

		const invocation = resolveInvocation({
			agents: [agent],
			spec: {
				agent: agent.name,
				task: "Review: {previous}",
				thinkingLevel: "high",
			},
			previousOutput: "prior output",
		});

		expect(invocation.task).toBe("Review: {previous}");
		expect(invocation.prompt).toBe("Task: Review: prior output");
		expect(invocation.promptKind).toBe("task");
		expect(invocation.display).toBe("Review:");
	});
});
