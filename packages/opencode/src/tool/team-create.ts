import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createTeamService } from "../team"
import { formatAgentID } from "../mailbox"
import { InstanceState } from "../effect"

const id = "team_create"

const parameters = z.object({
  name: z.string().describe("Name for the new team (alphanumeric, hyphens allowed)"),
  description: z.string().optional().describe("Brief description of the team's purpose"),
})

export const TeamCreateTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description: "Create a new team of agents. You become the coordinator. Use spawn_worker to add workers.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const teams = createTeamService(dir)
          const coordinatorID = formatAgentID("coordinator", params.name)

          const team = yield* Effect.promise(() =>
            teams.create(params.name, params.description ?? "", coordinatorID, ctx.sessionID as string),
          )

          return {
            title: `Team created: ${params.name}`,
            metadata: { teamName: team.name, coordinatorID },
            output: [
              `Team "${team.name}" created.`,
              `Coordinator ID: ${coordinatorID}`,
              `Config: .opencode/teams/${team.name}/config.json`,
              "",
              "Next: use spawn_worker to add workers to the team.",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
