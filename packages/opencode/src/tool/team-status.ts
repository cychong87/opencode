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
  wait_for_completion: z
    .boolean()
    .optional()
    .describe(
      "If true, blocks until ALL workers are idle/completed/failed (no active workers). This avoids expensive polling loops. Default: false.",
    ),
  timeout: z
    .number()
    .optional()
    .describe("Max seconds to wait when wait_for_completion is true. Default: 600 (10 min)."),
})

function formatStatus(teamName: string, workers: { name: string; agentID: string; status: string }[]) {
  const activeCount = workers.filter((m) => m.status === "active").length
  const idleCount = workers.filter((m) => m.status === "idle").length
  const completedCount = workers.filter((m) => m.status === "completed").length
  const failedCount = workers.filter((m) => m.status === "failed").length

  const lines: string[] = [
    `Team: ${teamName}`,
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

  return { lines, activeCount, idleCount }
}

export const TeamStatusTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description:
        "Check the status of all team members. Use wait_for_completion=true to block until all workers finish — this is much more efficient than polling in a loop. Returns each worker's name, status (active/idle/completed/failed), and agent ID.",
      parameters,
      execute: (params: z.infer<typeof parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const teams = createTeamService(dir)
          const waitForCompletion = params.wait_for_completion === true
          const timeoutSecs = params.timeout ?? 600

          const getWorkers = () =>
            Effect.promise(async () => {
              const team = await teams.get(params.team_name)
              return team.members.filter((m) => m.role === "worker")
            })

          if (waitForCompletion) {
            const deadline = Date.now() + timeoutSecs * 1000
            let workers = yield* getWorkers()
            let activeCount = workers.filter((m) => m.status === "active").length

            while (activeCount > 0 && Date.now() < deadline) {
              yield* Effect.sleep("5 seconds")
              workers = yield* getWorkers()
              activeCount = workers.filter((m) => m.status === "active").length
            }

            const { lines } = formatStatus(params.team_name, workers)
            const timedOut = activeCount > 0
            if (timedOut) {
              lines.push("")
              lines.push(`TIMED OUT after ${timeoutSecs}s — ${activeCount} worker(s) still active.`)
            }

            return {
              title: timedOut ? `timed out, ${activeCount} active` : "all workers done",
              metadata: {},
              output: lines.join("\n"),
            }
          }

          // Non-blocking: just check and return immediately
          const workers = yield* getWorkers()
          const { lines, activeCount, idleCount } = formatStatus(params.team_name, workers)

          return {
            title: `${activeCount} active, ${idleCount} idle`,
            metadata: {},
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
