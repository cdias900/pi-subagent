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
| `agent` + `task` | single | One agent, one task |
| `tasks` | parallel | Array of `{agent, task, cwd?, saveAs?, mcps?}` |
| `chain` | chain | Sequential with `{previous}` placeholder |
| `team` | all | Team name → `~/.pi/teams/{name}/` |
| `saveAs` | all | Output name (default: agent name) |
| `mcps` | per task | MCP server names to scope |
| `cwd` | all | Working directory |
| `agentScope` | all | `"user"` / `"project"` / `"both"` |

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
