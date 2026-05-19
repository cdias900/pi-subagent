# Parameterized Agents: Final Design Summary

**Date:** 2026-05-18

This document outlines the design and implementation of the parameterized agents feature in `pi-subagent`.

## Design Summary

Parameterized agents allow developers to define strict input schemas for their agents using JSON Schema. Instead of passing a freeform text `task`, the caller provides a structured JSON `input` object.

A key design decision was to **avoid generating individual tools per agent**. Generating a unique tool for every parameterized agent pollutes the LLM's tool namespace, increases context overhead, and makes agent discovery pagination difficult. Instead, all agents—both freeform and parameterized—are invoked through the same core `subagent` tool.

### Discovery Pattern
To mitigate the lack of individual tools, we introduced a two-step discovery process:
1. **`list_subagents()`**: Returns a compact list of available agents for the selected scope (default is "user"). It omits full JSON schemas and system prompts to keep the payload small, removing the need for pagination. Use `list_subagents({ agentScope: "both" })` to include project-local agents.
2. **`describe_agent({ agent: "name" })`**: Returns the full contract for a specific agent, including its JSON Schema for `parameters`, examples, and allowed tools. It explicitly omits the system prompt to save context window space. Use `describe_agent({ agent: "name", agentScope: "both" })` for project-local agents.

### Invocation and Self-Healing
Parameterized agents are invoked using the `input` parameter instead of `task`:

```typescript
subagent({
  agent: "researcher",
  input: { topic: "AI", depth: "deep" }
})
```

If an LLM mistakenly calls a parameterized agent using the `task` parameter instead of the required `input`, the tool will cleanly reject the call with an actionable error containing an example `input` payload. This acts as a self-healing mechanism, prompting the LLM to read the schema via `describe_agent` and try again using `input`. (Schema validation errors are reserved for invalid `input` payloads).

## Agent Frontmatter Fields

Agents define their schema and behavior via markdown frontmatter:

```yaml
---
name: researcher
parameters:
  type: object
  properties:
    topic: { type: string }
    depth: { type: string }
  required: [topic]
inputInstructions: "Use these parameters to configure the research."
allowFreeform: false
allowRuntimeTools: false
---
```

- `parameters`: An object JSON Schema defining the expected `input` structure (top-level `type: object` is required).
- `inputInstructions`: Optional context injected into the agent's prompt to explain how the parameters should guide its work.
- `allowFreeform`: A boolean flag. If `false`, the agent strictly requires `input` and will reject `task` calls. (Defaults to `true` if no `parameters` are defined).
- `allowRuntimeTools`: A boolean flag. If `false`, prevents the caller from injecting arbitrary tools into the agent that aren't defined in its frontmatter. (Defaults to `true` if no `parameters` are defined).

## Advanced Workflows

Parameterized agents seamlessly integrate with all existing `pi-subagent` features:

- **Background Execution**: Parameterized agents can be launched in the background just like freeform agents.
- **Parallel Tasks**: You can mix freeform `task` and structured `input` in an array of parallel agent executions.
- **Chains**: In sequential chains, the `{previous}` placeholder is fully supported. For parameterized agents, any string leaf within the `input` JSON object can contain `{previous}`, and it will be properly substituted with the upstream output before invocation.

## Caveats

- **No Per-Agent Tools**: As mentioned, you will not see a `subagent_researcher` tool. You must use `list_subagents` and `describe_agent` to discover schemas, and the standard `subagent` tool to invoke them.
- **Actual Subagents**: Parameterized agents still spawn as full, isolated subagent processes. They are not local function calls within the current agent's process. They have their own system prompts, context, and capabilities.

## Security Model

Project-local agents (whether parameterized or freeform) are repo-controlled code. `pi-subagent` requires a local TUI confirmation or an explicit caller opt-in (`confirmProjectAgents: false`) to run them. In RPC/API/headless contexts, the caller must perform its own confirmation, as `ctx.hasUI` is not treated as human consent (Pi's RPC UI protocol can be client-mediated). Default behavior is to fail-closed outside of a local TUI.
