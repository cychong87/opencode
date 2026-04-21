import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createTeamTaskService } from "../team-task"
import { InstanceState } from "../effect"

const id = "team_task_create"

const parameters = z.object({
  team_name: z.string().describe("Team name"),
  subject: z.string().describe("Brief task title"),
  description: z.string().describe("Detailed task description"),
  metadata: z.record(z.string(), z.any()).optional().describe("Optional metadata"),
})

export const TeamTaskCreateTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description: "Create a new task in the team's shared task list. Workers can see and claim tasks.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const taskService = createTeamTaskService(dir)
          const task = yield* Effect.promise(() =>
            taskService.create(params.team_name, {
              subject: params.subject,
              description: params.description,
              metadata: params.metadata,
            }),
          )
          return {
            title: `Task created: ${task.subject}`,
            metadata: { taskId: task.id },
            output: `Task created (${task.id}): ${task.subject}\nStatus: ${task.status}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
