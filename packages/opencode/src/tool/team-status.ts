import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createTeamService } from "../team"
import { InstanceState } from "../effect"

const id = "team_status"

const parameters = z.object({
  team_name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "Team name must be alphanumeric")
    .describe("Team name to check status of"),
})

export const TeamStatusTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description:
        "Check the status of all team members. Returns each worker's name, status (active/idle/completed/failed), and agent ID. Use this to determine when all workers have finished their tasks (all showing 'idle' status) so you can proceed to verification.",
      parameters,
      execute: (params: z.infer<typeof parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const teams = createTeamService(dir)

          const team = yield* Effect.promise(() => teams.get(params.team_name))
          const workers = team.members.filter((m) => m.role === "worker")

          const activeCount = workers.filter((m) => m.status === "active").length
          const idleCount = workers.filter((m) => m.status === "idle").length
          const completedCount = workers.filter((m) => m.status === "completed").length
          const failedCount = workers.filter((m) => m.status === "failed").length

          const lines: string[] = [
            `Team: ${team.name}`,
            `Workers: ${workers.length} total — ${activeCount} active, ${idleCount} idle, ${completedCount} completed, ${failedCount} failed`,
            "",
          ]

          for (const w of workers) {
            lines.push(`  ${w.name} (${w.agentID}): ${w.status}`)
          }

          if (activeCount === 0 && workers.length > 0) {
            lines.push("")
            lines.push("ALL WORKERS FINISHED. Proceed to verification phase now.")
          }

          return {
            title: `${activeCount} active, ${idleCount} idle`,
            metadata: {},
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
