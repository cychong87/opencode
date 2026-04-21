# Multi-Agent Team System

OpenCode now supports multi-agent coordination — a system where multiple AI agents work in parallel on different parts of a task, coordinated by a team coordinator.

## Overview

The multi-agent system adds 13 new tools that enable:

- **Background agent execution** — launch agents that run asynchronously
- **Inter-agent messaging** — agents exchange typed messages via file-based mailboxes
- **Team coordination** — create teams, spawn workers, assign tasks, shut down gracefully
- **Shared task lists** — team-wide work queues with status tracking and dependencies
- **Structured notifications** — XML-formatted completion reports

## When to Use Multi-Agent

Multi-agent coordination is most valuable when:

- A task has **3+ independent subtasks** that can run in parallel
- Changes span **5+ files across multiple packages**
- You need **research + implementation** separated (explorer feeds implementer)
- A large **refactor touches many subsystems** simultaneously

For simple single-file fixes or quick lookups, the standard single-agent approach is faster.

## Quick Start

### 1. Switch to the Coordinator Agent

Select the **coordinator** agent. It has a specialized system prompt that guides multi-agent orchestration.

### 2. Create a Team

The coordinator creates a team:
```
tool: team_create
  name: "feature-build"
  description: "Build the new auth feature"
```

### 3. Spawn Workers

Launch workers for independent subtasks:
```
tool: spawn_worker
  name: "researcher"
  prompt: "Find all authentication-related files and document the current auth flow"
  team_name: "feature-build"
  agent_type: "explore"

tool: spawn_worker
  name: "implementer"
  prompt: "Implement the new JWT token validation in auth/validate.ts"
  team_name: "feature-build"
  agent_type: "general"
```

Workers run in the background and send `idle_notification` when done.

### 4. Monitor Progress

Check for worker updates:
```
tool: check_mailbox
  agent_id: "coordinator@feature-build"
```

Track work items:
```
tool: team_task_list
  team_name: "feature-build"
```

### 5. Assign Follow-Up Work

Send new tasks to idle workers:
```
tool: send_message
  to: "researcher@feature-build"
  message: "Now find all the test files for the auth module"
  type: "task_assignment"
```

### 6. Shut Down

When done, terminate workers and delete the team:
```
tool: terminate_worker
  name: "researcher"
  team_name: "feature-build"

tool: terminate_worker
  name: "implementer"
  team_name: "feature-build"

tool: team_delete
  team_name: "feature-build"
```

## Tools Reference

### Background Execution (Sprint 1)

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `task` (modified) | Launch agent with `run_in_background: true` | `prompt`, `subagent_type`, `run_in_background` |
| `check_task` | Check/wait for background task results | `task_id`, `block`, `timeout` |
| `stop_task` | Cancel a running background task | `task_id` |

### Inter-Agent Messaging (Sprint 2)

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `send_message` | Send message to agent by ID | `to` (name@team), `message`, `type` |
| `check_mailbox` | Read unread inbox messages | `agent_id`, `mark_read` |

**Message Types**: `plain`, `task_assignment`, `idle_notification`, `shutdown_request`, `shutdown_approved`, `shutdown_rejected`, `plan_approval_request`, `plan_approval_response`

### Team Management (Sprint 3)

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `team_create` | Create a new team | `name`, `description` |
| `team_delete` | Delete team (all workers must be terminated) | `team_name` |
| `spawn_worker` | Launch worker with idle/resume lifecycle | `name`, `prompt`, `team_name`, `agent_type` |
| `terminate_worker` | Gracefully shut down a worker | `name`, `team_name` |

### Shared Task List (Sprint 3)

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `team_task_create` | Create task in team work queue | `team_name`, `subject`, `description` |
| `team_task_list` | List all tasks with status/owner | `team_name` |
| `team_task_update` | Update status, assign owner, set dependencies | `team_name`, `task_id`, `status`, `owner`, `add_blocked_by` |

## Architecture

### File Structure

```
.opencode/
├── teams/{team-name}/
│   ├── config.json          # Team configuration and member list
│   └── inboxes/
│       ├── coordinator.json  # Coordinator's inbox
│       ├── worker1.json      # Worker 1's inbox
│       └── worker2.json      # Worker 2's inbox
└── tasks/{team-name}/
    └── tasks.json            # Shared task list
```

### Worker Lifecycle

```
spawn_worker called
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
    ├── task_assignment or plain → Execute new task → loop back to idle
    │
    └── shutdown_request → Update status to "completed" → Exit
```

### Communication Flow

```
Coordinator                    Worker
    │                            │
    │── spawn_worker ──────────►│ (executes initial task)
    │                            │
    │◄── idle_notification ──────│ (task done, waiting)
    │                            │
    │── task_assignment ────────►│ (new work)
    │                            │
    │◄── idle_notification ──────│ (done again)
    │                            │
    │── shutdown_request ───────►│ (please stop)
    │                            │
    │   [worker exits]           │
```

## Development

### Running Tests

```bash
cd packages/opencode

# All tests
bun test

# Multi-agent tests only
bun test test/mailbox/ test/team/ test/team-task/ test/notification/ test/integration/
```

### Test Coverage

- **49 tests** across 5 test files covering:
  - Mailbox operations (send, read, concurrent writes, broadcast)
  - Team CRUD (create, add/remove members, delete safety)
  - Shared task list (create, update, dependencies, auto-filter)
  - XML notifications (format, escaping, worktree fields)
  - E2E integration (round-trip messaging, full lifecycle)

## Implementation Notes

- **Background execution** uses `EffectBridge.fork()` pattern (not `Effect.fork`) per AGENTS.md guidelines
- **File locking** uses the existing `src/util/lock.ts` reader-writer lock — no external dependencies added
- **All tools** follow the `Tool.define(id, Effect.gen(...))` pattern with `Effect.orDie` error handling
- **Zero breaking changes** — all existing tools and agents continue to work unchanged
- **Coordinator** is a new primary agent added alongside build/plan, disabled by default via config if not needed
