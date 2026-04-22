# Multi-Agent Team System

OpenCode now supports multi-agent coordination — a system where multiple AI agents work in parallel on different parts of a task, coordinated by a team coordinator.

## What's New

13 new tools, 1 new agent, 4 new modules — built across 5 sprints:

| Category | Tools | Purpose |
|----------|-------|---------|
| **Background Execution** | `run_in_background` (task param), `check_task`, `stop_task` | Launch agents without blocking, poll for results, cancel |
| **Messaging** | `send_message`, `check_mailbox` | 8 typed message types for agent-to-agent communication |
| **Team Management** | `team_create`, `team_delete`, `spawn_worker`, `terminate_worker` | Create teams, spawn parallel workers with idle/resume lifecycle |
| **Shared Tasks** | `team_task_create`, `team_task_list`, `team_task_update` | Team-wide work queue with owner assignment and dependency tracking |
| **Coordinator Agent** | Built-in `coordinator` agent | System prompt guiding Research → Plan → Delegate → Monitor → Synthesize → Verify |

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
3. `check_mailbox` — poll for idle notifications as workers complete
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
**Model**: GLM-4.5-air | **Verification**: 2 FAIL_TO_PASS tests

| Metric | Single (run 1) | Single (run 2) | Multi-Agent (4 workers) |
|--------|---------------|---------------|------------------------|
| **Time** | 596s (9:56) | 881s (14:41) | 1297s (21:37) |
| **Files modified** | 1 | 12 | 6 |
| **Tests** | **FAILED** (wrong fix) | **BROKEN** (IndentationError) | **2 PASSED** |
| **Tokens** | 3,648K | 6,779K | 7,846K |
| **Resolved** | **NO** | **NO** | **YES (partial)** |

**What happened**:
- **Single agent (run 1)**: Modified only `basic.py`, reverted `numbers.py`. Tests fail.
- **Single agent (run 2)**: Modified 12 files (good coverage!) but introduced an `IndentationError` in `numbers.py` — broke the codebase. Tests can't run.
- **Multi-agent**: Spawned 4 workers (`core-worker`, `physics-worker`, `polys-worker`, `misc-worker`). Workers completed by the 5-minute mark. Modified 6 files across 3 modules. **Tests pass.**

**Key insight**: The single agent attempted 12 files sequentially but broke the code with accumulated errors. The multi-agent approach gave each worker a focused scope, producing cleaner edits that didn't break each other.

### Lessons Learned

**1. Multi-agent's biggest advantage is correctness, not speed.** On the 21-file task, the single agent was faster but broke the code in both runs. Multi-agent was slower but produced working code. For large tasks, reliability matters more than raw speed.

**2. Context degradation is real.** A single agent editing 12+ files sequentially accumulates context and introduces errors (circular imports, indentation bugs). Workers with fresh, focused context avoid this — each only handles 2-5 files.

**3. Parallelism overhead is significant on small models.** With GLM-4.5-air (~8s/call), the overhead of team management (team_create, spawn_worker × N, check_mailbox × N, terminate × N) costs 70-100 seconds. This only pays off when the task takes 5+ minutes for a single agent.

**4. The crossover point for multi-agent value:**
- **<5 files**: Single agent wins (overhead > savings)
- **5-10 files**: Tie (depends on task structure)
- **>10 files**: Multi-agent wins (correctness advantage dominates)

**5. Both single agent runs failed on the 21-file task.** This isn't a fluke — the task exceeds what a single sequential agent can handle reliably with GLM-4.5-air. Multi-agent makes it tractable by decomposing into manageable pieces.

**6. Workers finish fast, coordinator overhead is the bottleneck.** In the multi-agent run, all 4 workers completed by minute 5. The remaining 16 minutes was the coordinator doing verification and additional edits. Reducing coordinator overhead is the key optimization target.

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
| Token budget is tight | **Single agent** | Multi-agent uses 1.5-2x more tokens |

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
```

Full diff: https://github.com/cychong87/opencode/compare/main...feature/multi-agent
