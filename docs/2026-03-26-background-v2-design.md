# Background Agents V2 — Parallel & Chain Modes

**Date:** 2026-03-26
**Status:** Draft
**Repo:** cdias900/pi-subagent
**Depends on:** V1 Background Agents (single mode, shipped)

## Summary

Extend `background: true` from single mode to parallel and chain modes. Background parallel launches N agents concurrently, all non-blocking. Background chain runs steps sequentially in the background, auto-advancing on completion. Both expose group-level and individual-level control via the existing companion tools (`subagent_steer`, `subagent_status`, `subagent_stop`).

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Group wrapper + individual agents | Clean group operations while preserving per-agent control |
| ID scheme | Group ID + `{groupId}/{agent}` members | Both group and individual addressing |
| Parallel failure | Best-effort (all run) | Matches blocking parallel behavior; user can `stop` manually |
| Chain failure | Stop on error | Matches blocking chain behavior |
| Chain step advancement | Auto-start next step | Background = autonomous; manual approval defeats the purpose |
| Notification granularity | Configurable via `notifyPerTask` param (default: true) | Per-member by default for visibility; group-only when parent wants less noise |
| Concurrency | Shared pool (max 8 total) | Parallel members compete for slots like individual agents |
| Widget display | One line per group | Keeps widget clean; details via `subagent_status` |
| Steer for parallel groups | Target individual member only | Steering "all at once" is rarely meaningful |
| Steer for chain groups | Target the active step | Natural — there's only one running agent |

## Architecture

### BackgroundGroup

New lightweight type that tracks a set of related background agents:

```typescript
interface BackgroundGroup {
  groupId: string;              // "parallel-1", "chain-1", or user's saveAs
  mode: "parallel" | "chain";
  memberIds: string[];          // ordered list of BackgroundAgent IDs
  status: "running" | "done" | "error" | "aborted";
  startTime: number;
  endTime?: number;

  // Chain-specific
  chainSteps?: ChainStepDef[];  // full step definitions
  currentStepIndex?: number;    // 0-based, which step is active
  previousOutput?: string;      // output from last completed step

  // Notifications
  notifyPerTask: boolean;       // true = per-member notifications; false = group-only

  // Team
  teamName?: string;
  saveAs?: string;              // group-level saveAs
}

interface ChainStepDef {
  agent: string;
  task: string;                 // original template (with {previous} placeholder)
  cwd?: string;
  saveAs?: string;
  mcps?: string[];
  extensions?: string[];
}
```

Storage:

```typescript
const backgroundGroups = new Map<string, BackgroundGroup>();
```

### BackgroundAgent changes

Add one optional field to the existing `BackgroundAgent` interface:

```typescript
interface BackgroundAgent {
  // ...all existing V1 fields unchanged...
  groupId?: string;   // set if this agent belongs to a group
}
```

No other changes to the BackgroundAgent type.

### ID Scheme

**Group IDs:** Auto-generated as `parallel-{N}` or `chain-{N}`, or the user's `saveAs` value if provided at the top level.

**Member IDs:** `{groupId}/{agent}` for unique agent names. `{groupId}/{agent}-{index}` when the same agent appears multiple times (e.g., two `executor` tasks in a parallel group).

Examples:
```
parallel-1/scout, parallel-1/executor, parallel-1/reviewer
chain-1/scout, chain-1/planner, chain-1/executor
research/scout-1, research/scout-2    (duplicate agents)
```

ID generation reuses the existing `generateBgId` pattern but adds group-aware deduplication:

```typescript
function generateGroupId(mode: "parallel" | "chain", explicitId?: string): string {
  if (explicitId && !backgroundGroups.has(explicitId)) return explicitId;
  const prefix = mode === "parallel" ? "parallel" : "chain";
  const counter = (bgAutoCounter.get(prefix) || 0) + 1;
  bgAutoCounter.set(prefix, counter);
  return `${prefix}-${counter}`;
}

function generateMemberId(groupId: string, agentName: string, agents: string[]): string {
  // If agent name is unique in the group, use groupId/agentName
  const dupeCount = agents.filter(a => a === agentName).length;
  if (dupeCount <= 1) return `${groupId}/${agentName}`;
  // For duplicates, append index
  const existingMembers = [...backgroundAgents.keys()]
    .filter(id => id.startsWith(`${groupId}/${agentName}`));
  return `${groupId}/${agentName}-${existingMembers.length + 1}`;
}
```

### Resolving IDs in companion tools

Companion tools accept either a group ID or an individual member ID:

```typescript
function resolveId(id: string): { type: "group"; group: BackgroundGroup } 
                                | { type: "agent"; agent: BackgroundAgent }
                                | { type: "not_found" } {
  const group = backgroundGroups.get(id);
  if (group) return { type: "group", group };
  const agent = backgroundAgents.get(id);
  if (agent) return { type: "agent", agent };
  return { type: "not_found" };
}
```

## Background Parallel

### Launch flow

When `subagent({ tasks: [...], background: true })`:

1. Validate: tasks ≤ `MAX_PARALLEL_TASKS` (8), all agents exist
2. Generate group ID
3. Create `BackgroundGroup` with mode `"parallel"`
4. For each task:
   - Generate member ID (`{groupId}/{agent}`)
   - Create `BackgroundAgent` with `groupId` set
   - Team mode: expand `{output:name}` placeholders in task, prepend shared context
5. Register all agents in `backgroundAgents` map
6. Launch agents that fit in concurrency slots; queue the rest
7. Return immediately

### Return value

```
Background parallel started: parallel-1 (3 tasks)
Members: parallel-1/scout (running), parallel-1/executor (running), parallel-1/reviewer (queued)
Use subagent_status(id: "parallel-1") to check progress.
```

### Member completion

When a parallel member completes (via `__bg_signal(done)`, implicit end, or error):

1. Handle as normal V1 completion (save output, cleanup process)
2. Check group: are all members terminal (done/error/aborted)?
3. If yes → finalize group:
   - Set group status: `"done"` if all succeeded, `"error"` if any failed
   - Save group-level output in team mode (concatenation of all member outputs)
   - Fire group notification with `triggerTurn: true`
4. If no → fire per-member notification with `triggerTurn: false` (only if `notifyPerTask: true`)

### Failure policy

**Best-effort** (matches blocking parallel): all tasks run regardless of sibling failures. The parent sees the full picture when the group completes. If the parent wants fail-fast, they can `subagent_stop(id: "parallel-1")` after seeing a member error notification.

No `failurePolicy` parameter in V2. YAGNI — add it if users actually need abort-all.

## Background Chain

### Launch flow

When `subagent({ chain: [...], background: true })`:

1. Validate: chain non-empty, all agents exist
2. Generate group ID
3. Create `BackgroundGroup` with mode `"chain"`, store all step definitions
4. Create `BackgroundAgent` for step 0 only:
   - Replace `{previous}` with `""` (first step has no previous)
   - Team mode: expand `{output:name}`, prepend shared context
   - Set `groupId` on the agent
5. Launch step 0 agent
6. Return immediately

### Return value

```
Background chain started: chain-1 (3 steps)
Step 1/3: scout — running
Use subagent_status(id: "chain-1") to check progress.
```

### Step advancement

When the current chain step completes:

**On success:**
1. Capture output from completed step
2. Save as `previousOutput` on the group
3. Team mode: save step output (`saveAs` from step definition, or `{agent}`)
4. If more steps remain:
   - Increment `currentStepIndex`
   - Create `BackgroundAgent` for next step:
     - Replace `{previous}` in task template with previous output
     - Replace `{output:name}` placeholders (team mode)
     - Set `groupId`
   - Add new agent to `memberIds`
   - Launch (respects concurrency queue)
   - Fire notification: `[🔗 chain-1] Step 2/3 started: executor` (triggerTurn: false)
5. If last step completed:
   - Set group status → `"done"`
   - Fire notification: `[✅ CHAIN DONE: chain-1] All 3 steps completed` (triggerTurn: true)

**On error:**
1. Set group status → `"error"`
2. Do NOT start remaining steps
3. Fire notification: `[❌ chain-1] Step 2/3 failed: executor — chain stopped` (triggerTurn: true)
4. Save partial chain output in team mode

### Where step advancement lives

The chain advancement logic hooks into the existing `handleBgSignal` and `proc.on("close")` handlers. After an agent transitions to `done` or `error`, check if it belongs to a chain group and advance accordingly:

```typescript
function onAgentCompleted(bgAgent: BackgroundAgent): void {
  if (!bgAgent.groupId) return;
  const group = backgroundGroups.get(bgAgent.groupId);
  if (!group) return;
  
  if (group.mode === "chain") {
    advanceChain(group, bgAgent);
  } else if (group.mode === "parallel") {
    checkParallelGroupCompletion(group);
  }
}
```

This function is called from the existing completion paths (after `handleBgSignal` runs and after `proc.on("close")` runs).

## Companion Tool Changes

### `subagent_status`

**Parameters:** unchanged (`id: string | undefined`)

**New behavior:**

| Input | Behavior |
|-------|----------|
| Omitted | Show all: groups (summarized) + solo agents |
| Group ID | Group summary + member status table |
| Member ID | Individual agent detail (unchanged from V1) |

**Group status display:**

```
Group: parallel-1 (parallel, 3 tasks)
Status: running (2/3 done)
Elapsed: 45s
Members:
  ✅ parallel-1/scout — done (12s, 3 turns)
  ⏳ parallel-1/executor — running (45s, 5 turns)
  ✅ parallel-1/reviewer — done (30s, 4 turns)
```

```
Group: chain-1 (chain, 3 steps)
Status: running — step 2/3
Elapsed: 30s
Steps:
  ✅ chain-1/scout — done (15s)
  ⏳ chain-1/executor — running (15s)
  ⏸️ step 3: reviewer — pending
```

**All-agents view** groups entries:

```
Background agents (2 groups, 1 solo):
  🔀 parallel-1 (parallel) — 2/3 done — 45s
  🔗 chain-1 (chain) — step 2/3 — 30s
  ⏳ auth-fix (solo) — running — 1m2s
```

### `subagent_steer`

**Parameters:** unchanged (`id: string, message: string, interrupt: boolean`)

**New behavior:**

| Input | Behavior |
|-------|----------|
| Individual member ID | Steer that agent (unchanged from V1) |
| Chain group ID | Steer the currently-active step agent |
| Parallel group ID | Error: "Specify a member to steer: parallel-1/scout, parallel-1/executor, ..." |

Rationale: Parallel members are independent — steering "all" is meaningless. Chain has exactly one active step at a time — the group ID is a natural alias for the active step.

### `subagent_stop`

**Parameters:** unchanged (`id: string`)

**New behavior:**

| Input | Behavior |
|-------|----------|
| Individual member ID | Stop that agent. If in a group, check group completion. For chains: stop chain (cancel remaining). |
| Group ID | Stop ALL members: abort running, cancel queued, skip pending chain steps |

Stopping a chain member implies stopping the chain (remaining steps won't run). This matches the error behavior — if a step fails, the chain stops.

## Notification Events

Notification granularity is configurable via the `notifyPerTask` parameter (default: `true`).

- **`notifyPerTask: true`** (default) — fire per-member/per-step notifications (non-interrupting) as each task progresses, plus group completion (triggerTurn). Best for visibility when the parent wants to monitor progress.
- **`notifyPerTask: false`** — suppress per-member/per-step notifications entirely. Only the group-level completion event fires (triggerTurn). Best when the parent wants minimal noise and will poll via `subagent_status`.

Group start and group abort notifications always fire regardless of `notifyPerTask`.

### Parallel

| Event | Message | triggerTurn | Requires `notifyPerTask` |
|-------|---------|-------------|--------------------------|
| Group started | `[🔀 STARTED parallel-1] 3 tasks: scout, executor, reviewer` | false | always |
| Member started (from queue) | `[🚀 parallel-1/scout started]` | false | yes |
| Member done | `[✅ parallel-1/scout] summary...` | false | yes |
| Member error | `[❌ parallel-1/scout] error...` | false | yes |
| Group done (all succeeded) | `[✅ GROUP DONE: parallel-1] 3/3 succeeded` | true | always |
| Group done (mixed) | `[⚠️ GROUP DONE: parallel-1] 2/3 succeeded, 1 failed` | true | always |
| Group aborted | `[🛑 ABORTED parallel-1]` | false | always |

### Chain

| Event | Message | triggerTurn | Requires `notifyPerTask` |
|-------|---------|-------------|--------------------------|
| Chain started | `[🔗 STARTED chain-1] 3 steps, starting: scout` | false | always |
| Step started | `[🔗 chain-1] Step 2/3 started: executor` | false | yes |
| Step done | `[✅ chain-1] Step 1/3 done: scout` | false | yes |
| Step error | `[❌ chain-1] Step 2/3 failed: executor — chain stopped` | true | always |
| Chain complete | `[✅ CHAIN DONE: chain-1] All 3 steps completed` | true | always |
| Chain aborted | `[🛑 ABORTED chain-1]` | false | always |

## Widget Display

Groups appear as single lines in the widget. Individual solo agents appear as before:

```
🤖 Background agents (5)
  🔀 parallel-1 — 2/3 done (45s)
  🔗 chain-1 — step 2/3 (30s)
  🏃 auth-fix — running (1m2s)
```

Widget entries for groups:

| Mode | Format |
|------|--------|
| Parallel | `🔀 {groupId} — {done}/{total} done ({elapsed})` |
| Chain | `🔗 {groupId} — step {current}/{total} ({elapsed})` |
| Solo (V1) | `🏃 {id} — {status} ({elapsed})` |

The `updateBgWidget` function iterates both `backgroundGroups` and `backgroundAgents` (filtering out grouped agents to avoid double-counting).

## Concurrency

Groups participate in the shared `MAX_BG_CONCURRENCY` (8) pool:

- **Parallel:** Each member is an independent agent competing for slots. A parallel group of 4 uses 4 slots. If only 2 slots are available, 2 members launch and 2 queue. Queued members drain normally via `trySpawnQueued`.
- **Chain:** Only the current step is running — uses 1 slot. When a step completes and the next launches, it reuses the freed slot immediately (or queues if pool is full from other work).
- **No priority:** Groups and solo agents share the same FIFO queue. No special treatment.

## Session Cleanup

`shutdownAllBackgroundAgents` already kills all agents. V2 adds:
- Set all group statuses to `"aborted"`
- Clear `backgroundGroups` map
- Save partial chain/parallel outputs in team mode

## Completed Retention

Groups follow the same eviction pattern as solo agents:
- Completed groups stay in the map for `subagent_status` queries
- Evict oldest completed groups when count exceeds `MAX_COMPLETED_RETENTION` (20)
- A group is "completed" when its status is done/error/aborted

## Parameter Changes

Remove the V1 guard that rejects `background: true` with parallel/chain:

```typescript
// V1: reject
if (params.background && (hasChain || hasTasks)) {
  return { content: [{ type: "text", text: "background: true is only supported in single mode (V1)." }], isError: true };
}

// V2: allow — route to background parallel/chain launch functions
```

One new parameter on `SubagentParams`:

```typescript
notifyPerTask: Type.Optional(
  Type.Boolean({
    description: "Fire per-task notifications for background parallel/chain (default: true). " +
      "Set false for group-only completion notifications.",
    default: true,
  }),
),
```

This parameter is only meaningful when `background: true` is set with `tasks` or `chain`. Ignored for single mode (V1 single background agents always notify on completion) and for blocking mode.

## Implementation Changes Summary

| Area | Change |
|------|--------|
| Types | Add `BackgroundGroup`, `ChainStepDef`; add `groupId` to `BackgroundAgent` |
| Maps | Add `backgroundGroups` alongside `backgroundAgents` |
| Params | Add `notifyPerTask` (boolean, default true) to `SubagentParams` |
| ID generation | Add `generateGroupId`, `generateMemberId` |
| Launch | Add `launchBackgroundParallel`, `launchBackgroundChain` |
| Completion | Add `onAgentCompleted` → `advanceChain` / `checkParallelGroupCompletion` |
| Notifications | Gate per-member/per-step messages on `group.notifyPerTask` |
| Companion tools | `resolveId` helper; group-aware status/steer/stop |
| Widget | Group-aware display (filter grouped agents, show group lines) |
| Cleanup | Group-aware shutdown and eviction |
| Guard removal | Remove the `background + parallel/chain` rejection |

All changes are in `index.ts`. No new files needed.

## V3 Scope (not in this spec)

- `failurePolicy: "abort-all"` parameter for parallel groups
- Background chain with `stepMode: true` (notify and wait between steps)
- Nested groups (background parallel where each task is itself a chain)
- Group-level cost tracking aggregation
