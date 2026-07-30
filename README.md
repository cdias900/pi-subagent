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

The `model` field is optional. When omitted, the agent inherits the parent PI model and reasoning level unless a global, session, invocation, or task override applies. Use `/agent-model` for session or global defaults, or pass `model` and `thinkingLevel` to `subagent` for one run.

## Model & Reasoning Selection

Use `/agent-model` in the interactive TUI for a guided picker. It shows each agent's effective model, reasoning level, and source, then lets you:

1. Choose an agent, or start with `/agent-model <agent>`.
2. Choose an available model, or clear the selected scope's override.
3. Choose a reasoning level supported by that model, or use the model default.
4. Save the choice for the current PI session or as a global default.

The guided flow is TUI-only. Direct set and reset forms work with a live TUI or RPC UI:

```text
/agent-model session <agent> <provider/model> [level]
/agent-model global <agent> <provider/model> [level]
/agent-model session <agent> reset
/agent-model global <agent> reset
```

In headless, JSON, or print modes, pass `model` and `thinkingLevel` to the `subagent` tool instead of using the command.

### Global Defaults

Global overrides are stored by agent name in `~/.pi/agent/subagent-models.json`:

```json
{
  "scout": {
    "model": "anthropic/claude-sonnet-4-6",
    "thinkingLevel": "high"
  },
  "reviewer": {
    "thinkingLevel": "off"
  }
}
```

`model` and `thinkingLevel` are independently optional. Global updates replace the file atomically with user-only permissions. If the file contains malformed JSON or invalid entries, pi-subagent reports the error and leaves the file unchanged rather than overwriting it. A malformed `~/.pi/agent/subagent-models.json` blocks all subagent dispatches until repaired. Agent discovery remains available through `list_subagents` and `describe_agent`, with configuration diagnostics included in their results.

### Session Lifecycle

Session overrides are saved in PI's session history. The latest values survive `/reload`, are restored when the session is resumed, and are inherited by forks. A new session starts without session overrides. Resetting an agent removes only the selected session or global scope.

### Resolution Rules

Model and reasoning fields resolve independently from highest to lowest priority:

```text
task > invocation > session > global > frontmatter > parent
```

- A higher-priority model-only override clears lower-priority reasoning, so the selected model uses its own default.
- A model may include a canonical suffix such as `provider/model:high`; a separate `thinkingLevel` at the same or higher priority wins over the suffix.
- Normalization emits a suffix-free model ID and passes the resolved reasoning level separately with the `--thinking` flag.
- Canonical levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Supported levels depend on the model. Non-reasoning models accept only `off`, and extended levels such as `xhigh` or `max` are available only when the model supports them.

#### Suffix collision with `:off` and `:max`

The set of trailing suffixes stripped and interpreted as reasoning levels was
extended by this PR. The five previously recognized tokens were `minimal`,
`low`, `medium`, `high`, and `xhigh`. The canonical set is now seven — `off`
and `max` were added — so `:off` and `:max` are now also stripped from a model
id and treated as reasoning levels.

This introduces a **suffix collision** that is syntactically undetectable: the
parser cannot distinguish a model tag from a reasoning level. A model id that
legitimately ends in `:off` or `:max` is now silently rewritten.

For example, an Ollama-style tag id such as `ollama/qwen:max`:

- **Before this PR** — passed through verbatim as a single `--model` value:
  `--model ollama/qwen:max`
- **After this PR** — split into a base id and a reasoning level:
  `--model ollama/qwen --thinking max`

**Practical impact:** if you use a model whose id genuinely ends in `:off` or
`:max`, pi-subagent will now dispatch a different model than the one you named
and pass an unintended `--thinking` level, with no warning. The collision
cannot be detected at parse time because the suffix is identical to a valid
reasoning token.

If a model ID genuinely ends in `:off` or `:max`, it cannot currently be
represented through pi-subagent's `model` field, because every model value
passes through the same suffix parser. Use a different model tag or alias that
does not end in a canonical reasoning token. For non-colliding model IDs,
prefer the separate `thinkingLevel` field instead of encoding reasoning in the
model ID.

### Per-Run Overrides

Top-level fields apply to the whole invocation. Fields on a parallel task or chain step override them for that item. Replace the example IDs with exact models available in PI.

**Single:**

```typescript
subagent({
  agent: "scout",
  task: "Map the authentication flow",
  model: "provider/model",
  thinkingLevel: "high"
})
```

**Parallel:**

```typescript
subagent({
  model: "provider/default-model",
  thinkingLevel: "low",
  tasks: [
    { agent: "scout", task: "Map the API" },
    {
      agent: "reviewer",
      task: "Review authentication",
      model: "provider/review-model",
      thinkingLevel: "high"
    }
  ]
})
```

**Chain:**

```typescript
subagent({
  model: "provider/default-model",
  thinkingLevel: "medium",
  chain: [
    { agent: "planner", task: "Plan the migration" },
    {
      agent: "executor",
      task: "Implement this plan: {previous}",
      model: "provider/coding-model",
      thinkingLevel: "max"
    }
  ]
})
```

Explicit selections are checked against the available, authenticated models and each model's supported reasoning levels. For parallel runs and chains, every task or step is resolved and validated before any subagent is spawned, including background runs. One invalid selection fails the whole run before spawning; reasoning levels are never silently clamped or downgraded.

> [!NOTE]
> The `/agent-model` picker deliberately manages user and bundled agents only. It does not list project-local agents or configure project-specific model policy.

## Commands

| Command | Description |
|---------|-------------|
| `/agent-model` | Open the guided model and reasoning picker (TUI only) |
| `/agent-model <agent>` | Open the guided picker for one agent (TUI only) |
| `/agent-model session <agent> <provider/model> [level]` | Set a current-session override (TUI or RPC UI) |
| `/agent-model global <agent> <provider/model> [level]` | Set a global default (TUI or RPC UI) |
| `/agent-model session <agent> reset` | Clear a current-session override (TUI or RPC UI) |
| `/agent-model global <agent> reset` | Clear a global default (TUI or RPC UI) |
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
| `tasks` | parallel | Array of `{agent, task?, input?, model?, thinkingLevel?, cwd?, saveAs?, mcps?}` |
| `chain` | chain | Sequential with `{previous}` placeholder (works in `task` or string leaves of `input`) |
| `model` | all / per task | Exact model override; top-level applies invocation-wide, while a task or chain step wins for that item |
| `thinkingLevel` | all / per task | Canonical reasoning override; top-level applies invocation-wide, while a task or chain step wins for that item |
| `team` | all | Team name → `~/.pi/teams/{name}/` |
| `saveAs` | all | Output name (default: agent name) |
| `mcps` | per task | MCP server names to scope |
| `cwd` | all | Working directory |
| `agentScope` | all | `"user"` / `"project"` / `"both"` |
| `confirmProjectAgents` | all | `true`/`false`. **Note:** Headless/API/RPC contexts require explicit `false` to run project agents. |

`list_subagents()` and `describe_agent()` include each agent's effective `model`, `thinkingLevel`, and winning configuration `source` so callers can inspect the selection before invoking it.

### Security Model: Project-Local Agents

Project-local agents are repo-controlled code and therefore untrusted by default. When `confirmProjectAgents` is true (the default), `pi-subagent` enforces a strict confirmation gate:
- In a local interactive TUI, it prompts the user for explicit approval.
- In RPC, API, or headless contexts, it **fails closed** and throws an error.

Because Pi's RPC UI protocol can be auto-answered by programmatic clients, `ctx.hasUI` alone is not treated as proof of human consent. Clients embedding `pi-subagent` via RPC or headless APIs must present their own UI confirmation to the user and then pass `confirmProjectAgents: false` to explicitly assert that trust was established.

## Package Structure

```
pi-subagent/
├── package.json             # PI package manifest
├── README.md
├── index.ts                 # Extension entry point, tools, commands, and process orchestration
├── agents.ts                # Agent discovery (bundled + user + project)
├── invocation.ts            # Invocation validation, prompt construction, and model layering
├── parameters.ts            # Parameter schema validation and discovery metadata
├── model-normalize.ts       # Model ID normalization and canonical reasoning levels
├── model-config.ts          # Global overrides and atomic persistence
├── model-session.ts         # Session override snapshots and restoration
├── model-resolution.ts      # Precedence, model lookup, and capability validation
├── agent-model-command.ts   # Guided and direct `/agent-model` flows
├── team.ts                  # Team directories, shared context, outputs, and placeholders
├── coordination.ts          # TeamCreate, TaskCreate, and SendMessage tools
├── bg-signal.ts             # Background child lifecycle signaling tool
└── agents/                  # Default agent definitions
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
