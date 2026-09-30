# pi-subagent

Multi-agent orchestration for PI. Spawn specialized agents, coordinate teams, and share context across agent workflows.

## Install

```bash
pi install git:github.com/cdias900/pi-subagent
```

## What You Get

### Subagent Tool

Run specialized agents in isolated Pi sessions:

```
subagent({ agent: "scout", task: "Explore the codebase" })
```

**Three modes:**

- **Single** — one agent, one task
- **Parallel** — multiple agents running concurrently
- **Chain** — sequential agents with `{previous}` placeholder for output handoff

### SDK execution

Every child uses the same **in-process Pi SDK session** path for foreground and background single, parallel, and chain runs. There is no backend selector, CLI runner, or agent sidecar. Each child has its own conversation, model runtime, resource loader, tools, and working directory. Extensions declared by an agent are loaded from the same installed sources as the parent, with fresh module state per child. They are not borrowed as live executable tools from the parent: Pi's public extension API exposes tool metadata, not execution callbacks.

Fresh extension modules avoid cross-agent mutable state (for example Buildkite's active abort signal) without extra Pi processes. Requested MCP servers are registered in per-session native extensions without changing global configuration or environment; stdio MCP servers may still start their own configured server processes. Model-key/header `!commands` are bound to the child's working directory without changing `process.cwd()`. Shared disk configuration remains user-owned.

This is context and extension-state isolation, **not a process or filesystem sandbox**. Trusted extensions that mutate global process state or block the event loop can still affect the parent. Abort is cooperative; there is no child Pi process to SIGKILL.

The target `cwd` follows the same non-interactive trust policy as a CLI child: saved trust or the global headless `defaultProjectTrust` setting. A parent session-only trust decision is not inherited by either backend. Children do not persist session files. SDK results use Pi's session statistics and the selected model's actual context window for usage display. Background SDK children use a real `__bg_signal` tool, remain available for questions/steering, and are cleaned up on completion or parent shutdown.

Run `npm run bench:sdk` for reproducible SDK startup/tool-completion measurements with and without an extension, using a local scripted model. This does **not** measure provider latency or a representative real-model workload. `npm test` covers SDK behavior and retains historical CLI option fixtures only as comparison evidence, not an executable backend. Set `PI_SUBAGENT_GATEWAY_EXTENSION_PATH=/path/to/pi-tool-gateway-extension/index.ts` to exercise the real Tool Gateway code against a local MCP endpoint. Set `PI_SUBAGENT_BUILDKITE_EXTENSION_PATH=/path/to/buildkite/index.ts` to verify separate extension modules keep concurrent calls' abort signals independent.

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
- `parameters`: Object JSON Schema for the `input` field (top-level `type: object` is required). This is the **existing schema-only input gate**: when present, the agent is parameterized and validates `input` against the schema before starting a child.
- `inputInstructions`: Optional guidance injected into the agent's prompt.
- `allowFreeform`: If `false`, the agent strictly requires `input` and rejects `task` (defaults to `true` if no parameters).
- `allowRuntimeTools`: If `false`, prevents the caller from injecting tools not defined by the agent (defaults to `true` if no parameters).
- `systemPromptMode`: `"append"` (default) or `"replace"`. Controls how the agent's system-prompt body is applied to the child session. See [Agent Isolation & System Prompt Mode](#agent-isolation--system-prompt-mode-phase-0).
- `noSkills` / `noPromptTemplates` / `noContextFiles`: Booleans that selectively disable the corresponding SDK resource-loader discovery in the child; `false` behaves like omission. See [Agent Isolation & System Prompt Mode](#agent-isolation--system-prompt-mode-phase-0).

### Agent Isolation & System Prompt Mode (Phase 0)

Phase 0 introduces isolation controls for parameterized and freeform agents so an
author can run a subagent with deterministic resource scoping.
These controls are **opt-in**: any agent that omits the new frontmatter fields
behaves exactly as before — nothing about existing agent definitions changes
unless you explicitly add the fields.

#### `systemPromptMode`

| Mode | Effect |
|------|--------|
| `"append"` (default, or omitted) | Pi discovers its normal APPEND and context files; the SDK loader adds the role once after APPEND and before AGENTS context. Skills, templates, and context remain enabled unless individually disabled. |
| `"replace"` | The role replaces the base prompt and suppresses discovered APPEND content, skills, templates, and context files. |

Append mode retains the target directory's saved/default project-trust decision
and APPEND selection (a trusted project APPEND takes precedence over the global
file). Background continuations start from the same base prompt, so role and
lifecycle instructions do not accumulate across turns.

In `"replace"` mode the three resource-discovery controls are always enabled as
a set, so `noSkills` / `noPromptTemplates` / `noContextFiles` are redundant there;
setting them to `false` does **not** re-enable discovery. Use `"append"` mode
with the individual `no*` flags when you want selective isolation rather than
full replacement.

#### `noSkills` / `noPromptTemplates` / `noContextFiles`

Only meaningful individually in `"append"` mode; `"replace"` disables all three.
`true` disables the corresponding discovery. `false` and omission leave it enabled.

#### `tools`: omitted vs `[]` vs non-empty

| `tools` value | Foreground SDK session | Background SDK session |
|---------------|------------------------|------------------------|
| omitted | Default built-ins and tools from requested extensions/MCPs | Same, plus `__bg_signal` |
| `[]` | No tools | Only `__bg_signal`; no task tools |
| non-empty (`[read, grep]`) | Only the listed tools | Listed tools plus `__bg_signal` (de-duplicated) |

**Compatibility change (intentional):** in earlier versions of pi-subagent, an
explicit `tools: []` in frontmatter was collapsed to `undefined`, so the spawned
process inherited Pi's default tool set. The SDK now preserves `[]` verbatim
and disables task tools, retaining only the background lifecycle signal. If you have
existing agents that relied on `tools: []` silently falling back to defaults,
**omit the `tools` field entirely** to keep the old behavior. Agents that already
omit `tools` are unaffected.

#### Background `__bg_signal` protocol

Every background SDK child receives an internal instruction and a directly
registered `__bg_signal` tool. The child calls it to report completion:

- `__bg_signal(status: "done", summary: "…")` — task finished
- `__bg_signal(status: "question", question: "…")` — needs input to continue
- `__bg_signal(status: "error", error: "…")` — unrecoverable failure

Call `__bg_signal` as the **only** tool in its assistant turn. The SDK backend
rejects a mixed batch and aborts before other tools execute, rather than
continuing model work after a completion signal.

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

`systemPromptMode: replace` already disables skill, template, and context
discovery. `tools: []` disables all foreground tools; background retains only
`__bg_signal`.

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

Control which MCP servers a subagent can access. Servers are selected from native Pi configuration: `~/.pi/agent/mcp.json` (or the configured agent directory) and the trusted child's `.pi/mcp.json`, both using `{ "mcpServers": { ... } }`. Project entries replace global entries with the same name. Scoped sessions use Pi's native MCP, codemode and tool-search extensions; there is no bridge or alternate client backend.

```
subagent({
  team: "my-project",
  agent: "reviewer",
  task: "Search for patterns",
  mcps: ["my-mcp"],        // only this MCP is loaded
  saveAs: "review"
})
```

Omit `mcps` for fastest startup (no MCP servers loaded). Configured exposure is preserved: `codemode` is Pi's default, `deferred` enables tool search, and `direct` declares tools immediately. Native MCP owns transport validation, headers/secrets, OAuth credentials, resources, reconnection and shutdown. Authenticate OAuth servers in the parent Pi session with `/mcp login <server>` or `pi mcp login <server>`; children reuse the native credential store and do not open an unattended sign-in flow. Legacy flat bridge files, `PI_MCP_CONFIG`, bridge credentials and SSE fallback are not supported.

### Native SDK startup-cancellation limitation

Pi 0.99.1 does not retain its native client for shutdown until initialization finishes. Cancelling or disposing a child stops new agent work and closes established MCP connections, but a connection still initializing can remain alive until initialization settles or its native request timeout fires (60 seconds by default, configurable per server). This is an upstream native-runtime limitation, not a bridge fallback: subagents do not recreate clients, import private SDK internals or kill arbitrary server processes to hide it. Regression tests use a two-second loopback timeout to verify the observed delayed cleanup; their passing result does not imply immediate startup teardown.

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

The `model` field is optional. When omitted, the agent inherits the parent PI model and reasoning level unless a legacy global, session, invocation, or task override applies. Use `/agent-model` for a session-only selection or to update an existing user agent's frontmatter. When invocation overrides are enabled, `model` and `thinkingLevel` can also be passed to `subagent` for one run.

## Model & Reasoning Selection

Use `/agent-model` in the interactive TUI for a guided picker. It shows each agent's effective model, reasoning level, and source, then lets you:

1. Choose an agent, or start with `/agent-model <agent>`.
2. Choose an available model, or clear the selected scope's model setting.
3. Choose a reasoning level supported by that model, or use the model default.
4. Save the choice for the current Pi session or persist it in the user agent file.

The guided flow is TUI-only. Direct set and reset forms work with a live TUI or RPC UI:

```text
/agent-model session <agent> <provider/model> [level]
/agent-model global <agent> <provider/model> [level]
/agent-model session <agent> reset
/agent-model global <agent> reset
```

`global` is retained in the command syntax for compatibility, but it now means "persist in user-agent frontmatter." In headless, JSON, or print modes, edit the agent frontmatter before starting the run, or pass `model` and `thinkingLevel` to `subagent` when per-invocation overrides are enabled.

### Durable User-Agent Selection

A global `/agent-model` selection updates the discovered user agent's existing Markdown file. Reasoning is stored as the canonical model suffix:

```yaml
model: "anthropic/claude-sonnet-4-6:high"
```

The edit is an atomic, conflict-checked replacement that preserves the prompt body, unrelated frontmatter, comments, newline style, and file mode. `/agent-model global <agent> reset` removes the top-level `model` field. It does not restore a same-named bundled agent's model; a model-less user definition inherits the parent Pi model.

Only regular `user`-source agent files inside `~/.pi/agent/agents/` are editable. Bundled agents, project agents, and symlinked agent files are rejected; create a regular user-owned copy before persisting a selection. A current session override still wins over newly saved frontmatter and is reported as the effective source.

### Legacy Global Overrides

Existing `~/.pi/agent/subagent-models.json` files remain readable for compatibility and retain their historical precedence above frontmatter. `/agent-model` no longer writes ordinary selections to this file. If the selected agent still has a legacy JSON entry, a durable frontmatter change is rejected because the JSON value would mask it; move or remove that entry first. Reasoning-only legacy entries cannot always be migrated without changing inheritance semantics.

Malformed legacy JSON continues to block dispatch while leaving discovery available with diagnostics. `/agent-model global reset --force` remains a legacy recovery command that backs up a corrupt file and writes a clean `{}`; it never removes model fields from agent definitions.

### Session Lifecycle

Session overrides are saved in Pi's session history. The latest values survive `/reload`, are restored when the session is resumed, and are inherited by forks. A new session starts without session overrides. A session reset removes only that session override; a global reset removes the user agent's frontmatter `model` field.

### Resolution Rules

Model and reasoning fields resolve independently from highest to lowest priority:

```text
task > invocation > session > legacy global JSON > frontmatter > parent
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

### Invocation Override Policy

Per-invocation model and reasoning overrides are enabled by default for backward compatibility. Configure the persistent user policy in `~/.pi/agent/subagent-settings.json`:

```json
{
  "allowInvocationModelOverrides": false
}
```

When the file is missing, or the field is omitted, the default is `true`. Set it to `false` to prevent callers from changing an agent's configured model or reasoning level. The value must be a JSON boolean; malformed files, unknown keys, and non-boolean values fail extension registration with an actionable configuration error instead of silently enabling overrides.

When disabled, `model` and `thinkingLevel` are omitted from the top-level, parallel-task, and chain-step tool schemas. Direct or resumed calls that still contain either field are rejected before confirmation, queueing, or process spawn. The policy does not affect agent frontmatter, parent-model inheritance, `/agent-model`, session selections, or legacy global defaults. Run `/reload` (or restart Pi) after editing the file.

### Per-Run Overrides

When `allowInvocationModelOverrides` is `true`, top-level fields apply to the whole invocation. Fields on a parallel task or chain step override them for that item. Replace the example IDs with exact models available in PI.

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

## Monitoring Running Agents

A blocking parallel `subagent` call occupies the turn, so the model cannot call tools to inspect or stop a stuck agent. Slash commands still run mid-turn, which is how these work.

`/agents` opens a full-height sidebar docked to the right, refreshing every 500ms. One row per agent, foreground and background together, showing:

- status icon (⏳ running, ✓ done, ✗ failed/aborted, ⏸ queued/waiting)
- agent id (`fg-N` for foreground) and agent name
- elapsed time
- the in-flight tool (`tool:bash`) or `(awaiting model)`
- `idle:` — time since that agent last emitted an event

The last two fields are the point of the panel. An agent sitting in `tool:bash` with a climbing idle clock is running a long command and is healthy; `(awaiting model)` with a stale clock means it is wedged waiting on the provider.

| Key | Action |
|-----|--------|
| `↑` `↓` | Select agent (list) / scroll transcript (expanded) |
| `⏎` | Open the selected agent's transcript / return to the list |
| `Tab` | Next agent (expanded view) |
| `PgUp` `PgDn` | Scroll transcript by ten lines |
| `Home` `End` | Jump to oldest / newest output |
| `k` | Kill the selected agent |
| `q` `Esc` | Close the panel |

### Transcript view

Pressing Enter widens the overlay and splits it into two panes — agent list left, selected agent's transcript right. The transcript is chronological and complete: the prompt, every assistant turn, each tool call and its result. It follows new output as it streams, but stops following once you scroll up so you can read without being yanked to the bottom; `End` re-pins it. The same chronological transcript now backs the expanded (`Ctrl+O`) tool-call view for single, chain and parallel runs.

### Run status and partial results

These changes modify existing behavior:

- Agents show ⏳ while running and only switch to ✓ when the SDK run settles or the CLI child process exits. Previously a checkmark appeared as soon as an agent produced its first turn.
- If one task in a parallel batch fails or is aborted, the other tasks' results are still returned, with the failed one marked ✗ and its error shown. Previously a throw from any task rejected the whole call and discarded results from tasks that had already finished. Callers that treated a parallel throw as "nothing ran" should be aware results now come back.
- Spawn failures report the underlying error (for example `spawn failed: spawn pi ENOENT`) instead of `(no output)`.
- Each foreground run gets its own abort controller, so `/kill-agent` and the panel's `k` stop exactly one agent. A top-level abort (Escape) still cascades to all of them.

### Concurrency limits

A parallel `subagent` call accepts up to 50 agents and runs all of them at once — the cap on how many you can declare and the worker-pool size are the same number, so a full fan-out starts immediately rather than queueing. The same limit governs background agents: background jobs beyond the limit are queued and start automatically as running slots free up. Override it with the `PI_SUBAGENT_MAX_AGENTS` environment variable.

All children share the Pi process and make independent model calls. Large fan-outs still consume memory and push against provider rate limits; lower the cap if agents stall.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PI_SUBAGENT_MAX_AGENTS` | `50` | Max agents in a parallel call, and how many run concurrently (foreground and background combined) |

## Commands

| Command | Description |
|---------|-------------|
| `/agent-model` | Open the guided model and reasoning picker (TUI only) |
| `/agent-model <agent>` | Open the guided picker for one agent (TUI only) |
| `/agent-model session <agent> <provider/model> [level]` | Set a current-session override (TUI or RPC UI) |
| `/agent-model global <agent> <provider/model> [level]` | Persist model/reasoning in an existing user agent's frontmatter (TUI or RPC UI) |
| `/agent-model session <agent> reset` | Clear a current-session override (TUI or RPC UI) |
| `/agent-model global <agent> reset` | Remove an existing user agent's frontmatter `model` field (TUI or RPC UI) |
| `/team` | List all teams |
| `/team new <name>` | Create a team |
| `/team info <name>` | Show team details and outputs |
| `/team outputs <name>` | List saved output files |
| `/team delete <name>` | Delete team and all data |
| `/agents` | Open the live agents panel (TUI only) |
| `/kill-agent <id>` | Kill one running agent by id, leaving its siblings running |

## Subagent Parameters

| Parameter | Scope | Description |
|-----------|-------|-------------|
| `agent` + `task` | single | One agent, freeform task |
| `agent` + `input` | single | One agent, structured JSON input |
| `tasks` | parallel | Array of `{agent, task?, input?, model?, thinkingLevel?, cwd?, saveAs?, mcps?}`; model fields are exposed only when invocation overrides are enabled |
| `chain` | chain | Sequential with `{previous}` placeholder (works in `task` or string leaves of `input`); model fields are exposed only when invocation overrides are enabled |
| `model` | all / per task | Exact model override; available only when invocation overrides are enabled. Top-level applies invocation-wide, while a task or chain step wins for that item |
| `thinkingLevel` | all / per task | Canonical reasoning override; available only when invocation overrides are enabled. Top-level applies invocation-wide, while a task or chain step wins for that item |
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
├── index.ts                 # Extension entry point, tools, commands, and orchestration
├── sdk-runner.ts            # Ephemeral SDK child sessions and trust/resource configuration
├── sdk-extensions.ts        # Fresh child extension modules using the host SDK
├── sdk-model-runtime.ts     # Cwd-bound model command credentials
├── sdk-mcp.ts               # Requested-server selection and native MCP extension setup
├── agents.ts                # Agent discovery (bundled + user + project)
├── invocation.ts            # Invocation validation, prompt construction, and model layering
├── invocation-policy.ts     # Per-invocation model override configuration and enforcement
├── parameters.ts            # Parameter schema validation and discovery metadata
├── model-normalize.ts       # Model ID normalization and canonical reasoning levels
├── model-config.ts          # Legacy global override compatibility and recovery
├── model-session.ts         # Session override snapshots and restoration
├── model-resolution.ts      # Precedence, model lookup, and capability validation
├── agent-model-command.ts   # Guided and direct `/agent-model` flows
├── agent-model-file.ts      # Atomic user-agent frontmatter model persistence
├── team.ts                  # Team directories, shared context, outputs, and placeholders
├── coordination.ts          # TeamCreate, TaskCreate, and SendMessage tools
└── agents/                  # Default agent definitions
    ├── scout.md
    ├── planner.md
    ├── executor.md
    └── reviewer.md
```

## Compatibility

- **Version 3 requires Pi 0.99.1 or later.** Native MCP is the only MCP runtime. Older Pi SDKs and the bridge backend are not supported; update Pi before updating this package. Interoperability aliases for other explicitly requested extensions still resolve to the current host SDK, not an older SDK copy.
- Scoped MCP keeps the native `mcp__server__tool` names, selected-server boundary, child cwd and project-trust rules. Server fields and exposure follow Pi's native contract, including `toolExposure`, environment/command-based secrets, OAuth, resources, timeouts and tilde paths. Disabled or unconfigured requested servers cannot be selected. No custom client, transport fallback, tool conversion, cache or bridge credential reader remains.
- **`/agent-model global` now edits user-agent frontmatter.** It no longer writes ordinary selections to `subagent-models.json`. Existing legacy JSON entries are still read and must be migrated or removed before changing the same agent's frontmatter.
- **Invocation model overrides remain enabled by default.** Existing callers keep the current `model` and `thinkingLevel` fields unless `allowInvocationModelOverrides` is set to `false` in `~/.pi/agent/subagent-settings.json`.
- **`tools: []` semantics (intentional change):** earlier pi-subagent versions
  collapsed an explicit empty `tools` list to `undefined`, so the child inherited
  Pi's default tools. The current behavior preserves `[]` and disables tools
  explicitly in the foreground, and retains only `__bg_signal` in the
  background (all task tools disabled). To keep the legacy "inherit defaults"
  behavior, **omit the `tools` field** rather than setting it to `[]`.
- **Existing agents are unchanged** when the new frontmatter fields
  (`systemPromptMode`, `noSkills`, `noPromptTemplates`, `noContextFiles`) are
  omitted. The isolation controls are strictly opt-in.

## License

MIT
