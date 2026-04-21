import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createTeamService } from "../team"
import { createMailbox, formatAgentID } from "../mailbox"
import { InstanceState } from "../effect"

const id = "terminate_worker"

const parameters = z.object({
  name: z.string().describe("Worker name to terminate"),
  team_name: z.string().describe("Team the worker belongs to"),
})

export const TerminateWorkerTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description:
        "Gracefully terminate a worker by sending a shutdown_request. The worker will finish its current task then stop.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const teams = createTeamService(dir)
          const mailbox = createMailbox(dir)
          const agentID = formatAgentID(params.name, params.team_name)
          const coordinatorID = (ctx.extra?.agentID as string | undefined) ?? formatAgentID("coordinator", params.team_name)

          yield* Effect.promise(() =>
            mailbox.send({
              from: coordinatorID,
              to: agentID,
              type: "shutdown_request",
              content: "Shutdown requested by coordinator",
              summary: `Shutdown ${params.name}`,
            }),
          )

          // Also mark as killed in team file in case the worker doesn't process the message
          yield* Effect.promise(() => teams.updateStatus(params.team_name, agentID, "killed"))

          return {
            title: `Worker terminated: ${params.name}`,
            metadata: {},
            output: `Shutdown request sent to ${agentID}. Worker status set to killed.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
