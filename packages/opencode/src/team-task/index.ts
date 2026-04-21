import { mkdir } from "fs/promises"
import path from "path"
import * as Lock from "../util/lock"

export interface Task {
  id: string
  subject: string
  description: string
  status: "pending" | "in_progress" | "completed" | "deleted"
  owner?: string
  blockedBy?: string[]
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface TeamTaskService {
  create(team: string, input: { subject: string; description: string; metadata?: Record<string, unknown> }): Promise<Task>
  list(team: string): Promise<Task[]>
  get(team: string, taskId: string): Promise<Task | undefined>
  update(
    team: string,
    taskId: string,
    updates: {
      status?: Task["status"]
      owner?: string
      subject?: string
      description?: string
      addBlockedBy?: string[]
      metadata?: Record<string, unknown>
    },
  ): Promise<Task>
}

function generateTaskID(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

export function createTeamTaskService(baseDir: string): TeamTaskService {
  function tasksPath(team: string) {
    return path.join(baseDir, ".opencode", "tasks", team, "tasks.json")
  }

  function lockKey(team: string) {
    return "tasks:" + tasksPath(team)
  }

  async function ensureDir(team: string) {
    await mkdir(path.dirname(tasksPath(team)), { recursive: true })
  }

  async function loadTasks(team: string): Promise<Task[]> {
    const file = Bun.file(tasksPath(team))
    if (!(await file.exists())) return []
    const text = await file.text()
    if (!text.trim()) return []
    return JSON.parse(text) as Task[]
  }

  async function saveTasks(team: string, tasks: Task[]) {
    await Bun.write(tasksPath(team), JSON.stringify(tasks, null, 2))
  }

  return {
    async create(team, input) {
      await ensureDir(team)
      using _ = await Lock.write(lockKey(team))
      const tasks = await loadTasks(team)
      const task: Task = {
        id: generateTaskID(),
        subject: input.subject,
        description: input.description,
        status: "pending",
        metadata: input.metadata,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      tasks.push(task)
      await saveTasks(team, tasks)
      return task
    },

    async list(team) {
      using _ = await Lock.read(lockKey(team))
      const tasks = await loadTasks(team)
      // Filter out deleted tasks
      const visible = tasks.filter((t) => t.status !== "deleted")
      // Build set of completed task IDs for auto-filtering blockedBy
      const completedIDs = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id))
      // Remove completed IDs from blockedBy arrays
      return visible.map((t) => ({
        ...t,
        blockedBy: t.blockedBy?.filter((id) => !completedIDs.has(id)),
      }))
    },

    async get(team, taskId) {
      using _ = await Lock.read(lockKey(team))
      const tasks = await loadTasks(team)
      return tasks.find((t) => t.id === taskId)
    },

    async update(team, taskId, updates) {
      await ensureDir(team)
      using _ = await Lock.write(lockKey(team))
      const tasks = await loadTasks(team)
      const task = tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`Task not found: ${taskId}`)

      if (updates.status !== undefined) task.status = updates.status
      if (updates.owner !== undefined) task.owner = updates.owner
      if (updates.subject !== undefined) task.subject = updates.subject
      if (updates.description !== undefined) task.description = updates.description
      if (updates.metadata !== undefined) task.metadata = { ...task.metadata, ...updates.metadata }
      if (updates.addBlockedBy) {
        task.blockedBy = [...(task.blockedBy ?? []), ...updates.addBlockedBy]
      }
      task.updatedAt = Date.now()

      await saveTasks(team, tasks)
      return task
    },
  }
}

export * as TeamTask from "./index"
