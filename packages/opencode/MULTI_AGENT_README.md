# Multi-Agent Team System

OpenCode now supports multi-agent coordination — a system where multiple AI agents work in parallel on different parts of a task, coordinated by a team coordinator.

## What's New

13 new tools, 1 new agent, 4 new modules — built across 5 sprints:

| Category | Tools | Purpose |
|----------|-------|---------|
| **Background Execution** | `run_in_background` (task param), `check_task`, `stop_task` | Launch agents without blocking, poll for results, cancel |
| **Messaging** | `send_message`, `check_mailbox` | 8 typed message types for agent-to-agent communication |
| **Team Management** | `team_create`, `team_delete`, `spawn_worker`, `terminate_worker`, `team_status` | Create teams, spawn parallel workers with idle/resume lifecycle, check completion |
| **Shared Tasks** | `team_task_create`, `team_task_list`, `team_task_update` | Team-wide work queue with owner assignment and dependency tracking |
| **Coordinator Agent** | Built-in `coordinator` agent | System prompt guiding Plan → Delegate → Monitor → Verify → Cleanup |

## How It Differs From Standard Subagents

OpenCode already had the `task` tool for spawning subagents. The agent team adds:

| Capability | Before (task tool) | After (agent team) |
|-----------|-------------------|-------------------|
| Execution | Blocks parent until done | Background — parent continues |
| Communication | Return value only | Bidirectional mailbox with typed messages |
| Lifecycle | One-shot (run and exit) | Idle/resume loop — worker stays alive for multiple tasks |
| Coordination | None | Coordinator agent with workflow guidance |
| Work tracking | Per-session todo only | Shared team task list with owner and dependencies |
| Shutdown | Kill or wait | Graceful protocol (request → finish current work → exit) |
| Parallelism | Sequential (blocked) | True parallel — multiple workers run simultaneously |

## When to Use

Multi-agent is most valuable when a task has **3+ independent subtasks** that can run in parallel. For example:

- Build 3 independent modules simultaneously
- Research auth system + implement API endpoint + write docs — all at once
- Refactor multiple packages in parallel using worktree isolation

**Don't use multi-agent for**: single-file fixes, quick lookups, tasks with sequential dependencies. The overhead of team setup adds latency for simple work.

## Quick Start

### 1. Select the Coordinator Agent

Use `--agent coordinator` when running opencode, or switch agents in the TUI.

### 2. Describe Your Task

The coordinator will decide whether to work directly or spawn a team. For complex parallel work, you can explicitly request team creation:

```
Build 3 independent Python modules: a Matrix class, a TextAnalyzer class, and a FileManager class.
Each has its own source file and test file. They have zero dependencies on each other.
Use spawn_worker to build all 3 in parallel.
```

### 3. The Coordinator Orchestrates

The coordinator will:
1. `team_create` — create the team
2. `spawn_worker` × 3 — launch workers for each module
3. `team_status` — check when all workers are idle
4. Verify results — run tests
5. `terminate_worker` + `team_delete` — clean up

### 4. Workers Run in Parallel

Each worker:
- Executes its assigned task independently
- Sends `idle_notification` when done
- Waits for new tasks or shutdown via mailbox
- Operates in the correct project directory

## Evaluation Results

### Case Study 1: Toy Task — Build 3 Independent Python Modules

**Task**: Create Matrix, TextAnalyzer, and FileManager classes with tests — 3 completely independent modules.
**Model**: GLM-4.5-air via Z.AI Coding Plan

| Metric | Single Agent | Multi-Agent (3 workers) |
|--------|-------------|----------------------|
| **Wall-clock time** | 240s (4:00) | **176s (2:56)** |
| **Speedup** | baseline | **27% faster** |
| **All modules created** | Yes (3/3) | Yes (3/3) |
| **Tests passing** | 102 | 52 |
| **Tokens used** | 661K | 1,211K |
| **Workers spawned** | 0 | 3 (parallel) |

**Observation**: Multi-agent is faster but uses more tokens and produces fewer tests per worker. The speed gain comes from genuine parallelism — 2 workers finished before the 3rd.

### Case Study 2: SWE-bench Verified — SymPy `is_finite` Bug (6 files)

**Task**: `sympy__sympy-16597` — fix `Symbol("m", even=True).is_finite` returning `None`. Changes to 6 files across 4 SymPy subsystems.
**Model**: GLM-4.5-air | **Verification**: 3 FAIL_TO_PASS tests

| Metric | Single Agent | Multi-Agent (3 workers) |
|--------|-------------|----------------------|
| **Resolved** | **YES** (3/3) | **YES** (3/3) |
| **Time** | **172s (2:52)** | 213s (3:33) |
| **Files changed** | 5 | 5 (same set) |
| **Tokens** | 778K | 787K |

**Result**: Both resolved it. Single agent was faster on this medium-sized task — the multi-agent overhead (team setup, mailbox polling) exceeded the parallel savings.

### Case Study 3: SWE-bench Verified — SymPy Rich Comparison (21 files)

**Task**: `sympy__sympy-13091` — fix comparison methods across 21 files in 6 modules to return `NotImplemented` instead of `False` for unknown types.
**Verification**: 2 FAIL_TO_PASS tests (`test_equality`, `test_comparisons_with_unknown_type`)

#### Round 1: GLM-4.5-air

| Metric | Single (run 1) | Single (run 2) | Multi-Agent (4 workers) |
|--------|---------------|---------------|------------------------|
| **Time** | 596s (9:56) | 881s (14:41) | 1297s (21:37) |
| **Files modified** | 1 | 12 | 6 |
| **Tests** | **FAILED** (wrong fix) | **BROKEN** (IndentationError) | **2 PASSED** |
| **Tokens** | 3,648K | 6,779K | 7,846K |
| **Resolved** | **NO** | **NO** | **YES (partial)** |

#### Round 2: GLM-5 (before coordinator fix)

| Metric | Single Agent | Multi-Agent (4 workers) |
|--------|-------------|------------------------|
| **Time** | 2965s (49 min) | 863s (killed — stuck) |
| **Files modified** | 20 | 20 |
| **Tests** | **2 PASSED** | **1 FAILED** |
| **Tokens** | 7,541K | 2,057K |
| **Resolved** | **YES** | **NO** |
| **check_mailbox calls** | — | 115 (infinite loop) |

**Bug found**: The coordinator got stuck in an infinite `check_mailbox` polling loop after workers finished — it never proceeded to verification.

#### Round 3: GLM-5 (after coordinator fix)

Added `team_status` tool and rewrote coordinator prompt with explicit completion detection.

| Metric | Single Agent | Multi-Agent (Fixed) | Improvement |
|--------|-------------|---------------------|-------------|
| **Time** | 2965s (49 min) | **1516s (25 min)** | **1.95x faster** |
| **Files modified** | 20 | 20 | Same coverage |
| **Tests** | **2 PASSED** | **2 PASSED** | Both resolved |
| **Tokens** | 7,541K | **2,305K** | **3.3x cheaper** |
| **Resolved** | **YES** | **YES** | |
| **check_mailbox** | — | 30 (bounded) | Down from 115 |
| **team_status** | — | 67 | New tool |

**What the coordinator fix achieved**:
1. `team_status` tool — direct worker status check instead of blind mailbox polling
2. Rewritten prompt — explicit exit condition: "when team_status shows 0 active, run tests immediately"
3. Anti-pattern warnings — "Do NOT call check_mailbox more than 5 times without team_status"
4. The coordinator adapted mid-run: when core-worker was slow, it started editing files directly itself

#### Round 4: GLM-5 (blocking team_status — 3v3 balanced comparison)

Added `wait_for_completion=true` to `team_status` — blocks inside the tool until all workers finish, eliminating the LLM polling loop entirely. Ran 3 times each for both single and multi-agent to ensure statistical validity.

| Run | Mode | Time | Tokens | Tests | Resolved |
|-----|------|------|--------|-------|----------|
| H1 | Single | 2965s (49 min) | 7,541K | 2 PASSED | YES |
| H1b | Single | 2514s (42 min) | 7,209K | 2 PASSED | YES |
| H1c | Single | 2333s (39 min) | 4,913K | 2 PASSED | YES |
| I2 | Multi | 1414s (24 min) | 1,194K | 2 PASSED | YES |
| I3 | Multi | 2203s (37 min) | 235K | 2 PASSED | YES |
| I4 | Multi | 1441s (24 min) | 247K | 2 PASSED | YES |

**Resolve rate: 6/6 (100%) — both approaches reliable with GLM-5**

| Summary (n=3 each) | Single Agent | Multi-Agent | Improvement |
|---------------------|-------------|-------------|-------------|
| **Avg Time** | 2604s (43 min) | 1686s (28 min) | **1.54x faster** |
| **Avg Tokens** | 6,554K | 559K | **11.7x cheaper** |

**What blocking wait achieved**: Each polling call triggered a full LLM inference round (~15s, ~24K tokens). The coordinator was spending 93% of wall time on polling. Blocking `team_status` moves the wait from expensive LLM inference loops to a cheap `Effect.sleep` inside the tool. When the blocking wait times out (600s), the coordinator gets actionable options: wait again or jump in and help directly.

### Lessons Learned

**1. Multi-agent wins on speed AND cost for large tasks.** In a balanced 3v3 comparison with GLM-5, multi-agent averaged 1.54x faster and 11.7x cheaper in tokens than single-agent (both 100% resolve rate). With GLM-4.5-air, multi-agent was the *only* approach that produced working code (single agent failed twice).

**2. Polling is the #1 performance killer.** In Round 3, the coordinator spent 93% of wall time on 97 polling calls — each triggering a full LLM inference round. Moving the wait inside the tool (blocking `team_status`) eliminated this entirely. Lesson: never let an LLM agent poll in a loop; use blocking tools instead.

**3. Context degradation is real.** A single agent editing 12+ files sequentially accumulates context and introduces errors (circular imports, indentation bugs). Workers with fresh, focused context avoid this — each only handles 2-5 files.

**4. Completion detection must be tool-level, not prompt-level.** Prompt-based instructions ("check regularly", "stop after N calls") are unreliable — LLMs ignore limits. The blocking `wait_for_completion` parameter is deterministic and cannot be ignored.

**5. The crossover point for multi-agent value:**
- **<5 files**: Single agent wins (overhead > savings)
- **5-10 files**: Tie (depends on task structure)
- **>10 files**: Multi-agent wins (speed + correctness + cost)

**6. Parallelism overhead is significant on small models.** With GLM-4.5-air (~8s/call), the overhead of team management costs 70-100 seconds. This only pays off when the task takes 5+ minutes for a single agent.

### When to Use Multi-Agent

| Scenario | Recommendation | Why |
|----------|---------------|-----|
| 10+ files across multiple modules | **Multi-agent** | Single agent breaks code with accumulated errors |
| 3+ independent subtasks, each >2 min | **Multi-agent** | Parallel savings exceed overhead |
| Large refactoring (same pattern, many files) | **Multi-agent** | Workers apply pattern in parallel |
| Research + implement + test pipeline | **Multi-agent** | Separate explorer, implementer, tester |
| Single-file bug fix | **Single agent** | No parallelism to exploit |
| Small tasks (<5 files, <50 lines) | **Single agent** | Overhead exceeds savings |
| Sequential dependencies between changes | **Single agent** | Workers can't parallelize dependent work |
| Token budget is tight | **Multi-agent** | With blocking wait, multi-agent uses 6x fewer tokens on large tasks |

## Tools Reference

### Background Execution

| Tool | Parameters | Description |
|------|-----------|-------------|
| `task` (modified) | `run_in_background: true` | Launch agent asynchronously, returns `task_id` |
| `check_task` | `task_id`, `block?`, `timeout?` | Poll or wait for background agent result |
| `stop_task` | `task_id` | Cancel a running background agent |

### Inter-Agent Messaging

| Tool | Parameters | Description |
|------|-----------|-------------|
| `send_message` | `to` (name@team), `message`, `type?`, `summary?` | Send typed message to agent |
| `check_mailbox` | `agent_id`, `mark_read?` | Read unread messages from inbox |

**8 Message Types**: `plain`, `task_assignment`, `idle_notification`, `shutdown_request`, `shutdown_approved`, `shutdown_rejected`, `plan_approval_request`, `plan_approval_response`

### Team Management

| Tool | Parameters | Description |
|------|-----------|-------------|
| `team_create` | `name`, `description?` | Create team, caller becomes coordinator |
| `team_delete` | `team_name` | Delete team (requires all workers terminated) |
| `spawn_worker` | `name`, `prompt`, `team_name`, `agent_type?` | Launch worker with idle/resume lifecycle |
| `terminate_worker` | `name`, `team_name` | Graceful shutdown via mailbox |
| `team_status` | `team_name` | Check all member statuses (active/idle/completed/failed) |

### Shared Task List

| Tool | Parameters | Description |
|------|-----------|-------------|
| `team_task_create` | `team_name`, `subject`, `description` | Create task in team work queue |
| `team_task_list` | `team_name` | List tasks with status, owner, blockedBy |
| `team_task_update` | `team_name`, `task_id`, `status?`, `owner?`, `add_blocked_by?` | Update task fields |

## Architecture

### File Structure

```
.opencode/
├── teams/{team-name}/
│   ├── config.json          # Team config: name, coordinator, members[]
│   └── inboxes/
│       ├── coordinator.json  # Coordinator's message inbox
│       ├── worker1.json      # Worker 1's inbox
│       └── worker2.json      # Worker 2's inbox
└── tasks/{team-name}/
    └── tasks.json            # Shared task list with dependencies
```

### Worker Lifecycle

```
spawn_worker(name, prompt, team)
    │
    ▼
[Create child session + register in team file]
    │
    ▼
[Execute initial task via ops.prompt()]
    │
    ▼
[Send idle_notification to coordinator]
    │
    ▼
[Poll mailbox every 500ms]
    │
    ├── task_assignment → Execute new task → back to idle
    │
    └── shutdown_request → Set status "completed" → Exit
```

### Communication Flow

```
Coordinator                    Worker
    │                            │
    │── spawn_worker ──────────►│ (executes initial task)
    │                            │
    │◄── idle_notification ──────│ (done, waiting)
    │                            │
    │── task_assignment ────────►│ (new work)
    │                            │
    │◄── idle_notification ──────│ (done again)
    │                            │
    │── shutdown_request ───────►│
    │                            │
    │   [worker exits cleanly]   │
```

## Development

### Running from Source

The multi-agent tools are only available when running from the `feature/multi-agent` branch:

```bash
# Build the dev binary
cd packages/opencode && bun run build --skip-embed-web-ui

# Run from built binary (recommended)
./dist/opencode-darwin-arm64/bin/opencode run --agent coordinator "your prompt"

# Or run directly via bun (note: --cwd changes process.cwd)
bun run --cwd packages/opencode --conditions=browser src/index.ts run --agent coordinator "your prompt"
```

### Running Tests

```bash
cd packages/opencode

# All tests (includes multi-agent)
bun test

# Multi-agent tests only (49 tests)
bun test test/mailbox/ test/team/ test/team-task/ test/notification/ test/integration/
```

### Test Coverage

49 tests across 5 files:

| Test File | Tests | What It Covers |
|-----------|-------|---------------|
| `test/mailbox/mailbox.test.ts` | 16 | Send/read, concurrent writes, broadcast, FIFO order, all 8 message types |
| `test/team/team.test.ts` | 8 | Create, add/remove members, status updates, delete safety |
| `test/team-task/team-task.test.ts` | 12 | Create, update, owner assignment, blockedBy dependencies, auto-filter |
| `test/notification/notification.test.ts` | 5 | XML format, escaping, worktree fields |
| `test/integration/multiagent.test.ts` | 8 | E2E mailbox round-trip, broadcast, team lifecycle, shared tasks |

## Implementation Notes

- **Background execution** uses `EffectBridge.fork()` via the `TaskPromptOps.fork()` extension — the only correct pattern for spawning background work from within a tool (per AGENTS.md)
- **File locking** uses existing `src/util/lock.ts` reader-writer lock — no external dependencies
- **Worker CWD** — workers receive the project directory in their prompt to ensure they operate in the correct location (Sprint 5 fix)
- **No breaking changes** — all existing tools and agents work unchanged
- **Zero regressions** — 2059 existing tests continue to pass

## Commit History

```
S1: 17bbde87c — Background agents + check_task + stop_task
S2: de3f14930 — Mailbox system + send_message + check_mailbox
S3: cc5741d3e — Team + shared tasks + worker lifecycle
S4: 785202ab8 — Coordinator agent + notifications + E2E + README
S5: cc1289673 — Code review bugfixes (6 fixes)
S6: 008172aa1 — Worker CWD fix
S7: 562ede096 — check_mailbox mark_read default fix
S8: e6bd63633 — team_status tool + coordinator polling loop fix
S9: 01da27b96 — blocking team_status (wait_for_completion) + prompt simplification
```

Full diff: https://github.com/cychong87/opencode/compare/main...feature/multi-agent
