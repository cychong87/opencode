import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createTeamService } from "../team"
import { InstanceState } from "../effect"

const id = "team_delete"

const parameters = z.object({
  team_name: z.string().describe("Name of the team to delete"),
})

export const TeamDeleteTool = Tool.define(
  id,
  Effect.gen(function* () {
    const run = Effect.fn("TeamDeleteTool.execute")(function* (
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      const dir = yield* InstanceState.directory
      const teams = createTeamService(dir)
      yield* Effect.promise(() => teams.delete(params.team_name))
      return {
        title: `Team deleted: ${params.team_name}`,
        metadata: {} as Record<string, unknown>,
        output: `Team "${params.team_name}" deleted. All files cleaned up.`,
      }
    })

    return {
      description:
        "Delete a team. All workers must be terminated first. Use terminate_worker to shut down each worker before deleting the team.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              title: "Team delete failed",
              metadata: {} as Record<string, unknown>,
              output: `Cannot delete team "${params.team_name}": it has active members. Terminate all workers first.`,
            }),
          ),
        ),
    }
  }),
)
