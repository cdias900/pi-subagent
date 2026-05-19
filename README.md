# pi-subagent

Multi-agent orchestration for PI. Spawn specialized agents, coordinate teams, and share context across agent workflows.

## Install

```bash
pi install git:github.com/cdias900/pi-subagent
```

## What You Get

### Subagent Tool

Spawn isolated PI processes as specialized agents:

```
subagent({ agent: "scout", task: "Explore the codebase" })
```

**Three modes:**

- **Single** — one agent, one task
- **Parallel** — multiple agents running concurrently
- **Chain** — sequential agents with `{previous}` placeholder for output handoff

### Parameterized Agents

Agents can define strict input schemas (JSON Schema) and be invoked with structured data instead of freeform text. Parameterized agents do not generate individual tools per agent; they all run through the same `subagent` tool.

**Discovery Tools:**
- `list_subagents()`: Returns a compact list of available agents for the selected scope (default is "user"). Use `list_subagents({ agentScope: "both" })` to include project-local agents (no full schemas or pagination).
- `describe_agent({ agent: "name" })`: Returns the full contract for a specific agent (schema, examples, tools), omitting the system prompt. Use `describe_agent({ agent: "name", agentScope: "both" })` for project-local agents.

**Invocation:**
Instead of `task`, use `input` for parameterized agents:
```typescript
subagent({
  agent: "researcher",
  input: { topic: "AI", depth: "deep" }
})
```
*Note: If a task string is provided when input is required, the tool rejects the invocation with an actionable error and example `input`, prompting the LLM to use the correct `input` parameter.*

**Agent Frontmatter:**
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
- `parameters`: Object JSON Schema for the `input` field (top-level `type: object` is required).
- `inputInstructions`: Optional guidance injected into the agent's prompt.
- `allowFreeform`: If `false`, the agent strictly requires `input` and rejects `task` (defaults to `true` if no parameters).
- `allowRuntimeTools`: If `false`, prevents the caller from injecting tools not defined by the agent (defaults to `true` if no parameters).

**Advanced Workflows:**
Parameterized agents fully support background mode, parallel tasks, and chains. In chains, string leaves in the `input` object can use the `{previous}` placeholder to inject upstream outputs.

### Team Coordination

Persistent shared context and named outputs across multiple agent invocations:

```
subagent({
  team: "my-project",
  chain: [
    { agent: "scout", task: "Recon the API", saveAs: "recon" },
    { agent: "planner", task: "Plan based on: {output:recon}", saveAs: "plan" },
    { agent: "executor", task: "Implement: {output:plan}", saveAs: "impl" }
  ]
})
```

Team data lives in `~/.pi/teams/{name}/`:

```
~/.pi/teams/my-project/
  team.json           # metadata
  shared_context.md   # injected into every agent's task
  outputs/            # named outputs from agents
    recon.md
    plan.md
    impl.md
  tasks.json          # task board
  messages.jsonl      # message log
```

### Team Tools (Claude Code Agent Teams compatible)

These tools are compatible with [Claude Code's agent team system](https://code.claude.com/docs/en/agent-teams), so skills and workflows written for that system work in PI without modification:

- **TeamCreate** / **TeamDelete** — team lifecycle
- **TaskCreate** / **TaskUpdate** / **TaskList** — task board with status tracking and dependencies
- **SendMessage** — append-only message log for coordination

### MCP Scoping for Subagents

Control which MCP servers a subagent can access (requires [pi-mcp-bridge](https://github.com/cdias900/pi-mcp-bridge)):

```
subagent({
  team: "my-project",
  agent: "reviewer",
  task: "Search for patterns",
  mcps: ["grokt-mcp"],        // only this MCP is loaded
  saveAs: "review"
})
```

Omit `mcps` for fastest startup (no MCP servers loaded).

## Default Agents

The package ships with 4 agents. Users can override any by creating a same-named `.md` file in `~/.pi/agent/agents/`.

| Agent | Role | Tools |
|-------|------|-------|
| **scout** | Fast codebase recon — scan, map, compress findings | read, grep, find, ls, bash |
| **planner** | Architectural planning — read-only, produces detailed plans | read, grep, find, ls |
| **executor** | Code implementation — writes and modifies code | all |
| **reviewer** | Code review — finds bugs, security, performance issues | read, grep, find, ls, bash |

### Customizing Agents

Override a default agent by creating `~/.pi/agent/agents/{name}.md`:

```markdown
---
name: scout
description: Fast recon with my preferred model
model: anthropic/claude-sonnet-4-6
tools: read, grep, find, ls, bash
---

Your custom system prompt here...
```

The `model` field is optional. When omitted, the agent uses PI's current session model.

## Commands

| Command | Description |
|---------|-------------|
| `/team` | List all teams |
| `/team new <name>` | Create a team |
| `/team info <name>` | Show team details and outputs |
| `/team outputs <name>` | List saved output files |
| `/team delete <name>` | Delete team and all data |

## Subagent Parameters

| Parameter | Scope | Description |
|-----------|-------|-------------|
| `agent` + `task` | single | One agent, freeform task |
| `agent` + `input` | single | One agent, structured JSON input |
| `tasks` | parallel | Array of `{agent, task?, input?, cwd?, saveAs?, mcps?}` |
| `chain` | chain | Sequential with `{previous}` placeholder (works in `task` or string leaves of `input`) |
| `team` | all | Team name → `~/.pi/teams/{name}/` |
| `saveAs` | all | Output name (default: agent name) |
| `mcps` | per task | MCP server names to scope |
| `cwd` | all | Working directory |
| `agentScope` | all | `"user"` / `"project"` / `"both"` |
| `confirmProjectAgents` | all | `true`/`false`. **Note:** Headless/API/RPC contexts require explicit `false` to run project agents. |

### Security Model: Project-Local Agents

Project-local agents are repo-controlled code and therefore untrusted by default. When `confirmProjectAgents` is true (the default), `pi-subagent` enforces a strict confirmation gate:
- In a local interactive TUI, it prompts the user for explicit approval.
- In RPC, API, or headless contexts, it **fails closed** and throws an error.

Because Pi's RPC UI protocol can be auto-answered by programmatic clients, `ctx.hasUI` alone is not treated as proof of human consent. Clients embedding `pi-subagent` via RPC or headless APIs must present their own UI confirmation to the user and then pass `confirmProjectAgents: false` to explicitly assert that trust was established.

## Package Structure

```
pi-subagent/
├── package.json        # PI package manifest
├── README.md
├── index.ts            # Entry point: subagent tool + team commands
├── agents.ts           # Agent discovery (bundled + user + project)
├── team.ts             # Team dir, shared context, named outputs, placeholders
├── coordination.ts     # TeamCreate, TaskCreate, SendMessage tools
└── agents/             # Default agent definitions
    ├── scout.md
    ├── planner.md
    ├── executor.md
    └── reviewer.md
```

## License

MIT
