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

### Case Study 2: Real-World SWE-bench Task — SymPy `is_finite` Bug

**Task**: SWE-bench Verified instance `sympy__sympy-16597` — fix `Symbol("m", even=True).is_finite` returning `None` instead of `True`. Requires changes to 6 files across 4 SymPy subsystems: core assumptions, ask system, power evaluation, tensor indexing.
**Model**: GLM-4.5-air via Z.AI Coding Plan
**Verification**: 3 FAIL_TO_PASS tests must pass after fix

| Metric | Single Agent | Multi-Agent (3 workers) |
|--------|-------------|----------------------|
| **Resolved (tests pass)** | **YES** (3/3) | **YES** (3/3) |
| **Wall-clock time** | **172s (2:52)** | 213s (3:33) |
| **Files correctly changed** | 5 | 5 (same set) |
| **Tokens used** | 778K | 787K |
| **Workers spawned** | 0 | 3 |
| **Team created** | No | Yes (`sympy-fix`) |

**What happened in the multi-agent run**:
1. Coordinator created team `sympy-fix`
2. Spawned 3 workers: `assumptions-core` (3 coupled files), `power-evaluation` (1 file), `tensor-indexing` (1 file)
3. `power-evaluation` and `tensor-indexing` completed first (simpler changes)
4. `assumptions-core` took longer (3 files with interdependencies)
5. Coordinator verified all 3 FAIL_TO_PASS tests passed
6. Both treatments produced the correct fix

### Lessons Learned

**1. Multi-agent works on real-world tasks.** Both the toy example and the SWE-bench task were resolved correctly by the coordinator with parallel workers. The infrastructure (team creation, worker spawning, mailbox communication, idle/resume lifecycle) works end-to-end.

**2. Parallelism overhead is real.** The coordinator adds ~40-70 seconds of overhead for team setup, worker spawning, mailbox polling, and shutdown. This overhead only pays off when the parallel savings exceed it. For the 70-line SymPy fix, the overhead exceeded the savings (213s vs 172s). For the larger toy task (3 modules), the savings exceeded the overhead (176s vs 240s).

**3. The breakeven point depends on task size AND model speed.**
- With GLM-4.5-air (~10s per LLM call), overhead ≈ 7-8 extra LLM calls ≈ 70-80s
- Each worker needs at least ~80s of work for parallelism to break even
- Rule of thumb: multi-agent helps when each worker's subtask would take >2 minutes solo

**4. Multi-agent works best when subtasks are truly independent.** The SWE-bench task had 3 independent change groups (core assumptions, power.py, indexed.py). Workers for the independent groups finished quickly. The coupled group (3 files with shared logic) took longer.

**5. Model capability matters.** GLM-4.5-air follows explicit instructions well but doesn't autonomously decide to use multi-agent tools. Stronger models (Claude, GPT-4o) would likely make better delegation decisions without explicit prompting.

**6. Both approaches produce correct results.** For the SWE-bench task, both single-agent and multi-agent modified the same 5 files and resolved the same 3 failing tests. Quality of the fix was equivalent.

### When to Use Multi-Agent

| Scenario | Recommendation | Why |
|----------|---------------|-----|
| 3+ independent subtasks, each >2 min | **Multi-agent** | Parallel savings exceed overhead |
| Large refactoring across many modules | **Multi-agent** | Workers own non-overlapping subsystems |
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
