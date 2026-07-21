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
systemPromptMode: append
noSkills: false
noPromptTemplates: false
noContextFiles: false
---
```
- `parameters`: Object JSON Schema for the `input` field (top-level `type: object` is required). This is the **existing schema-only input gate**: when present, the agent is parameterized and validates `input` against the schema before spawning.
- `inputInstructions`: Optional guidance injected into the agent's prompt.
- `allowFreeform`: If `false`, the agent strictly requires `input` and rejects `task` (defaults to `true` if no parameters).
- `allowRuntimeTools`: If `false`, prevents the caller from injecting tools not defined by the agent (defaults to `true` if no parameters).
- `systemPromptMode`: `"append"` (default) or `"replace"`. Controls how the agent's system-prompt body is applied to the spawned Pi process. See [Agent Isolation & System Prompt Mode](#agent-isolation--system-prompt-mode-phase-0).
- `noSkills` / `noPromptTemplates` / `noContextFiles`: Booleans that selectively disable Pi skills, prompt templates, and context files in the spawned agent. These are **additive `--no-*` flags**: setting any to `true` adds the corresponding flag; `false` is equivalent to omitting the field (no flag is added). See [Agent Isolation & System Prompt Mode](#agent-isolation--system-prompt-mode-phase-0).

### Agent Isolation & System Prompt Mode (Phase 0)

Phase 0 introduces isolation controls for parameterized and freeform agents so an
author can run a subagent with a deterministic, hermetically-scoped environment.
These controls are **opt-in**: any agent that omits the new frontmatter fields
behaves exactly as before — nothing about existing agent definitions changes
unless you explicitly add the fields.

#### `systemPromptMode`

| Mode | Spawn flags | Effect |
|------|-------------|--------|
| `"append"` (default, or omitted) | `--append-system-prompt <path>` | The agent's system-prompt body is appended to Pi's built-in system prompt. Skills, prompt templates, and context files remain enabled unless individually disabled. |
| `"replace"` | `--system-prompt <path>` **and** `--no-skills --no-prompt-templates --no-context-files` | The agent's system-prompt body **replaces** Pi's built-in system prompt entirely, and all three isolation flags are added automatically. `"replace"` mode is the strict-isolation preset. |

In `"replace"` mode the three isolation flags are always added as a set, so
`noSkills` / `noPromptTemplates` / `noContextFiles` are redundant there (setting
them to `true` does not add a second copy; setting them to `false` does **not**
re-enable anything — `replace` always isolates all three). Use `"append"` mode
with the individual `no*` flags when you want selective isolation rather than
full replacement.

#### `noSkills` / `noPromptTemplates` / `noContextFiles`

Only meaningful in `"append"` mode (in `"replace"` mode all three are auto-added).
Each is an additive flag:

- `noSkills: true` → adds `--no-skills` (disables Pi skills in the subagent)
- `noPromptTemplates: true` → adds `--no-prompt-templates`
- `noContextFiles: true` → adds `--no-context-files`
- `false` or omitted → no flag (the feature stays enabled)

Because the Pi CLI only has additive `--no-*` flags, `false` is behaviorally
indistinguishable from omitting the field. This is expected flag semantics, not
a bug.

#### `tools`: omitted vs `[]` vs non-empty

The `tools` frontmatter field controls which tools the spawned Pi process can
use. The three states have distinct, intentional semantics, and they differ
between foreground (synchronous) and background (RPC) spawns:

| `tools` value | Foreground spawn | Background spawn |
|---------------|------------------|------------------|
| omitted (no `tools` field) | no flag — child inherits Pi's default tools | no flag — existing behavior; `__bg_signal` is registered via the always-loaded bg-signal extension |
| `[]` (explicit empty list) | `--no-tools` — **all** built-in tools disabled | `--tools __bg_signal` — only the internal `__bg_signal` lifecycle tool is active; all task tools (built-in, extension, and MCP) are disabled |
| non-empty (`[read, grep]`) | `--tools read,grep` — restricted to the listed tools | `--tools read,grep,__bg_signal` — `__bg_signal` appended (de-duplicated) so the background protocol always works |

**Compatibility change (intentional):** in earlier versions of pi-subagent, an
explicit `tools: []` in frontmatter was collapsed to `undefined`, so the spawned
process inherited Pi's default tool set. It now preserves `[]` verbatim and
emits `--no-tools` (foreground) or `--tools __bg_signal` (background). If you have
existing agents that relied on `tools: []` silently falling back to defaults,
**omit the `tools` field entirely** to keep the old behavior. Agents that already
omit `tools` are unaffected.

#### Background `__bg_signal` protocol

Every background subagent spawns with the bundled `bg-signal` extension loaded
(`-e`) and an internal instruction appended to its system prompt. The child must
call the `__bg_signal` tool to report completion:

- `__bg_signal(status: "done", summary: "…")` — task finished
- `__bg_signal(status: "question", question: "…")` — needs input to continue
- `__bg_signal(status: "error", error: "…")` — unrecoverable failure

Because the background protocol depends on `__bg_signal`, the background tool-arg
helper never uses `--no-tools` for an empty list (that would disable the
extension-registered `__bg_signal` too) and always appends `__bg_signal` to a
non-empty allowlist. For an empty list it emits `--tools __bg_signal`, which is a
name allowlist: only the `__bg_signal` tool (registered by the always-loaded
bg-signal extension) is activated, and every task tool — built-in, extension, and
MCP — is disabled. This uses the standard `--tools` allowlist flag rather than
the `--no-builtin-tools` flag, so it is portable across Pi CLI versions that
support tool-name allowlists.

#### Strict-isolation example (ghostwriter-style)

A fully isolated, parameterized agent that replaces the system prompt and runs
with no skills, prompt templates, context files, or tools:

```markdown
---
name: ghostwriter
description: Strict isolation writer. Own system prompt only; no skills, templates, context, or tools.
systemPromptMode: replace
tools: []
allowFreeform: false
allowRuntimeTools: false
parameters:
  type: object
  properties:
    draft: { type: string }
  required: [draft]
---
You are a ghostwriter. Use only the provided `draft` input. Do not load skills,
prompt templates, or context files. Produce the final text and nothing else.
```

`systemPromptMode: replace` already adds `--no-skills --no-prompt-templates
--no-context-files`, so the individual `no*` flags are omitted here. `tools: []`
disables built-in tools in the foreground; in the background it becomes
`--tools __bg_signal` so `__bg_signal` remains available while all task tools are
disabled.

#### Out of scope for Phase 0

Phase 0 covers isolation flags and the omitted/empty/non-empty `tools` semantics
only. It does **not** include replacement agent definitions (re-defining the
bundled scout/planner/executor/reviewer as isolated agents) or retirement of the
existing wrapper-based agent definitions. Those are deferred to a later phase.

### Advanced Workflows
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
  mcps: ["my-mcp"],        // only this MCP is loaded
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

## Compatibility

- **`tools: []` semantics (intentional change):** earlier pi-subagent versions
  collapsed an explicit empty `tools` list to `undefined`, so the child inherited
  Pi's default tools. The current behavior preserves `[]` and disables tools
  explicitly: `--no-tools` in the foreground (all tools off), and
  `--tools __bg_signal` in the background (only the internal lifecycle tool is
  active; all task tools disabled). To keep the legacy "inherit defaults"
  behavior, **omit the `tools` field** rather than setting it to `[]`.
- **Existing agents are unchanged** when the new frontmatter fields
  (`systemPromptMode`, `noSkills`, `noPromptTemplates`, `noContextFiles`) are
  omitted. The isolation controls are strictly opt-in.
- The isolation flags (`--no-skills`, `--no-prompt-templates`,
  `--no-context-files`), the `--tools` name allowlist, and the `--system-prompt` /
  `--append-system-prompt` flags are standard Pi CLI flags available across modern
  Pi versions; the background empty-allowlist path uses `--tools __bg_signal`
  rather than the newer `--no-builtin-tools` flag, so no specific minimum Pi CLI
  version is required for the Phase 0 isolation controls. The bundled default
  agents (scout, planner, executor, reviewer) do not use any isolation flags.

## License

MIT
