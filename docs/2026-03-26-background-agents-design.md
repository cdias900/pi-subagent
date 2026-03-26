# Background Agents — Design Spec

**Date:** 2026-03-26
**Status:** Approved
**Repo:** cdias900/pi-subagent

## Summary

Add non-blocking execution to the subagent tool via `background: true`. Background agents run as RPC-mode Pi subprocesses, communicate with the parent via stdin/stdout JSON protocol, and expose companion tools for steering, status, and termination.

## Decisions

| Decision | Choice |
|----------|--------|
| New tool vs parameter | Parameter on existing tool (`background: true`), eventually replace blocking entirely |
| Job identification | Human-readable IDs via `saveAs` or auto-generated `{agent}-{N}` |
| Steering mid-turn | Queue by default, interrupt with `interrupt: true` flag |
| Completion notification | Custom message with `triggerTurn: true` for done/error/question |
| Mid-run progress | Custom message with `triggerTurn: false` — visible in TUI, doesn't interrupt parent LLM |
| Concurrency | Max 8 running, excess queued. Queue drains as slots free |
| End state detection | `__bg_signal` tool injected into agent's instructions |
| V1 scope | Single mode only. Parallel/chain background in V2 |

## Architecture

### `background` parameter

New optional boolean on `SubagentParams`. Default: `false` (existing blocking behavior, zero changes).

When `background: true`:
- Subprocess spawns with `--mode rpc` (not `--mode json -p`)
- stdin set to `"pipe"` for bidirectional RPC
- Initial task sent as `{"type": "prompt", "message": "Task: ..."}` via stdin
- Tool returns immediately with `{ jobId, agent, task, status: "running" }`

### Background agent state

```typescript
interface BackgroundAgent {
  id: string;                    // "auth-fix", "executor-1"
  agent: string;                 // "scout", "executor", etc.
  task: string;                  // original task text
  proc: ChildProcess;            // spawned pi process (stdin pipe)
  result: SingleResult;          // accumulating messages, usage, stderr
  status: "queued" | "running" | "waiting" | "done" | "error" | "aborted";
  startTime: number;
  endTime?: number;
  cwd: string;
}

const backgroundAgents = new Map<string, BackgroundAgent>();
```

### Status transitions

```
queued → running → done        (agent called __bg_signal(done) or implicit end)
                 → waiting     (agent called __bg_signal(question) — process alive)
                 → error       (non-zero exit, LLM error, or __bg_signal(error))
                 → aborted     (user called subagent_stop)

waiting → running              (parent steered with an answer)
        → aborted              (parent called subagent_stop)
```

### Concurrency queue

- Max 8 concurrent background processes
- Beyond 8, agents enter `"queued"` — not spawned yet, waiting for a slot
- When a running agent's process exits (done/error/abort), the next queued agent spawns
- `subagent_status` shows queued agents with position
- `subagent_stop` can cancel a queued agent before it starts
- `"waiting"` agents count toward the concurrency limit (process is alive)

## Companion Tools

### `subagent_steer`

Send a message to a running background agent.

**Parameters:**
- `id: string` — job ID
- `message: string` — what to tell the agent
- `interrupt: boolean` (default: false) — true aborts current turn first

**Implementation:**
- Default: `{"type": "steer", "message": "..."}` written to proc.stdin
- Interrupt: `{"type": "abort"}` first, brief wait, then `{"type": "prompt", "message": "..."}`
- Returns agent's current status, turn count, last tool call

### `subagent_status`

Check on background agents.

**Parameters:**
- `id: string | undefined` — specific job, or omit for all

**Returns:**
- Specific: status, turns, last few tool calls, usage, elapsed time
- All: summary table of running + queued + recently completed

### `subagent_stop`

Kill a background agent.

**Parameters:**
- `id: string` — job ID

**Implementation:** SIGTERM → 5s → SIGKILL. Status → `"aborted"`. Partial output saved if team mode. Frees concurrency slot, drains queue.

## End State Detection: `__bg_signal`

Background agents get additional instructions appended to their system prompt:

> You have a `__bg_signal` tool. You MUST call it when:
> - Your task is complete: `__bg_signal(status: "done", summary: "what you accomplished")`
> - You need input to continue: `__bg_signal(status: "question", question: "what you need")`
> - You hit an unrecoverable error: `__bg_signal(status: "error", error: "what went wrong")`

The `__bg_signal` tool is not a real tool in the child process. The parent detects it from the stdout event stream by watching for `tool_call` events with `name: "__bg_signal"`.

**Signal handling:**

| Signal | Parent action | triggerTurn | Process |
|--------|--------------|-------------|---------|
| `done` | Fire `[✅ DONE]`, save output | true | Kill |
| `question` | Fire `[❓ QUESTION]`, keep alive | true | Keep alive (`"waiting"`) |
| `error` | Fire `[❌ ERROR]` | true | Kill |
| No signal (implicit end) | Treat as done | true | Kill |

## Notification System

| Event | Display | triggerTurn |
|-------|---------|-------------|
| Turn completed (tool calls done) | `[⏳ auth-fix] Turn 3: ran bash, read 2 files` | false |
| `__bg_signal(done)` | `[✅ DONE from auth-fix]` + summary | true |
| `__bg_signal(error)` | `[❌ ERROR from auth-fix]` + details | true |
| `__bg_signal(question)` | `[❓ QUESTION from auth-fix]` + question | true |
| Process exited (no signal) | `[✅ DONE from auth-fix]` + final output | true |
| Agent aborted | `[🛑 ABORTED auth-fix]` | false |
| Agent dequeued and started | `[🚀 STARTED auth-fix]` (was queued) | false |

Custom renderer `"subagent-bg"` with expand/collapse support (same patterns as existing subagent renderer).

## RPC Protocol Details

Background agents use `pi --mode rpc --no-session --no-extensions` instead of `pi --mode json -p`.

**Key differences from blocking mode:**
- stdin is `"pipe"` (not `"ignore"`)
- Process stays alive after task completion (until explicitly killed)
- Initial task sent via stdin: `{"type": "prompt", "message": "Task: ..."}\n`
- Steering via stdin: `{"type": "steer", "message": "..."}\n`
- Abort via stdin: `{"type": "abort"}\n`
- stdout events are identical format to `--mode json` (`message_end`, `tool_result_end`, etc.)

**Idle detection:** When `message_end` fires with `stopReason: "endTurn"` and no pending tool calls, the agent is idle. If `__bg_signal(done)` was called, kill immediately. If `__bg_signal(question)` was called, enter `"waiting"`. If neither, treat as implicit done and kill.

## Implementation Changes

### `runSingleAgent` modifications

The existing function stays intact for blocking mode. For background mode, a new code path:

1. Build spawn args with `--mode rpc` instead of `--mode json -p`
2. Spawn with `stdio: ["pipe", "pipe", "pipe"]`
3. Register in `backgroundAgents` map
4. Wire up stdout parser (same `processLine` function)
5. Add `proc.on("close", ...)` handler for completion notification
6. Add `__bg_signal` detection in the event stream
7. Send initial prompt via stdin
8. Return immediately

### New files

None — all changes are in `index.ts`. The companion tools are registered alongside `subagent`.

## Session Cleanup

On `session_shutdown`:
- All running/waiting background agents get SIGTERM → 5s → SIGKILL
- Partial outputs saved to team if applicable
- Queued agents are dropped
- `backgroundAgents` map cleared

## Completed agents retention

Keep last 20 completed agents in the map for `subagent_status` queries. Evict oldest when limit exceeded.

## V2 Scope (not in this spec)

- `background: true` with parallel mode (fan-out N agents, all background)
- `background: true` with chain mode (background chain — each step fires when previous completes)
- TUI widget showing live streaming progress from all background agents
