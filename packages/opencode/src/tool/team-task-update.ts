import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createTeamTaskService } from "../team-task"
import { InstanceState } from "../effect"

const id = "team_task_update"

const parameters = z.object({
  team_name: z.string().describe("Team name"),
  task_id: z.string().describe("ID of the task to update"),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional().describe("New status"),
  owner: z.string().optional().describe("Assign to a worker (worker name)"),
  subject: z.string().optional().describe("Update task title"),
  description: z.string().optional().describe("Update task description"),
  add_blocked_by: z.array(z.string()).optional().describe("Task IDs that must complete before this task"),
})

export const TeamTaskUpdateTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description: "Update a task in the team's shared task list. Can change status, assign owner, or set dependencies.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const taskService = createTeamTaskService(dir)
          const task = yield* Effect.promise(() =>
            taskService.update(params.team_name, params.task_id, {
              status: params.status,
              owner: params.owner,
              subject: params.subject,
              description: params.description,
              addBlockedBy: params.add_blocked_by,
            }),
          )
          return {
            title: `Task updated: ${task.subject}`,
            metadata: { taskId: task.id },
            output: `Task ${task.id} updated.\nStatus: ${task.status}${task.owner ? `\nOwner: ${task.owner}` : ""}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
