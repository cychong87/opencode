import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createTeamTaskService } from "../team-task"
import { InstanceState } from "../effect"

const id = "team_task_list"

const parameters = z.object({
  team_name: z.string().describe("Team name"),
})

export const TeamTaskListTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description: "List all tasks in the team's shared task list. Shows status, owner, and dependencies.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const taskService = createTeamTaskService(dir)
          const tasks = yield* Effect.promise(() => taskService.list(params.team_name))

          if (tasks.length === 0)
            return { title: "No tasks", metadata: {}, output: "No tasks in the team task list." }

          const lines = tasks.map((t) => {
            const parts = [`[${t.status}] ${t.id}: ${t.subject}`]
            if (t.owner) parts.push(`  Owner: ${t.owner}`)
            if (t.blockedBy && t.blockedBy.length > 0) parts.push(`  Blocked by: ${t.blockedBy.join(", ")}`)
            return parts.join("\n")
          })

          return {
            title: `${tasks.length} tasks`,
            metadata: {},
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
