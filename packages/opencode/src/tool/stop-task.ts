import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import type { TaskPromptOps } from "./task"
import { SessionID } from "../session/schema"

const id = "stop_task"

const parameters = z.object({
  task_id: z.string().describe("The task_id of the background task to stop"),
})

export const StopTaskTool = Tool.define(
  id,
  Effect.succeed({
    description:
      "Stop a running background task by its task_id (session ID). Use this to cancel a task that was launched with run_in_background=true.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
        if (!ops)
          return {
            title: "Task stop failed",
            metadata: {},
            output: "Cannot stop task: not running in a session context with promptOps.",
          }
        const sessionID = SessionID.make(params.task_id)
        ops.cancel(sessionID)
        return {
          title: "Task stopped",
          metadata: {},
          output: `Stopped task ${params.task_id}. Session cancellation requested.`,
        }
      }),
  }),
)
