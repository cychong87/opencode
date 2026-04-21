import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import * as Session from "../session/session"
import { SessionID } from "../session/schema"
import type { MessageV2 } from "../session/message-v2"

const id = "check_task"

const parameters = z.object({
  task_id: z.string().describe("The task_id (session ID) of the background task to check"),
  block: z
    .boolean()
    .describe("If true, wait for the task to complete before returning. Default: false.")
    .optional(),
  timeout: z
    .number()
    .describe("Maximum time in milliseconds to wait when block=true. Default: 30000.")
    .optional(),
})

function isFinished(msg: MessageV2.WithParts): boolean {
  return msg.parts.some((p) => p.type === "step-finish")
}

function formatCompleted(session: Session.Info, msg: MessageV2.WithParts): Tool.ExecuteResult {
  const textPart = [...msg.parts].reverse().find((p) => p.type === "text")
  const text = textPart && "text" in textPart ? textPart.text : "(no text content)"
  return {
    title: "Task completed",
    metadata: { sessionId: session.id },
    output: [`Task completed (${session.id})`, `Title: ${session.title}`, "---", text].join("\n"),
  }
}

export const CheckTaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const run = Effect.fn("CheckTaskTool.execute")(function* (
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      const sessionID = SessionID.make(params.task_id)

      const session = yield* sessions.get(sessionID).pipe(
        Effect.catchCause(() => Effect.succeed(undefined as Session.Info | undefined)),
      )
      if (!session)
        return {
          title: "Task check",
          metadata: {},
          output: `Task not found: ${params.task_id}. The task_id may be incorrect or the session may have been deleted.`,
        }

      const msgs = yield* sessions.messages({ sessionID })
      const lastAssistant = [...msgs].reverse().find((m) => m.info.role === "assistant")

      // Already finished — return result immediately
      if (lastAssistant && isFinished(lastAssistant)) {
        const updated = yield* sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(session)))
        return formatCompleted(updated, lastAssistant)
      }

      // Not finished and not blocking — return current status
      if (!params.block) {
        if (!lastAssistant)
          return {
            title: "Task check",
            metadata: {},
            output: `Task (${params.task_id}) is starting up. No messages yet.`,
          }
        return {
          title: "Task check",
          metadata: {},
          output: `Task (${params.task_id}) is still running. Messages: ${msgs.length}`,
        }
      }

      // Blocking: poll every 500ms until finished, aborted, or timed out
      const timeoutMs = params.timeout ?? 30000
      const maxIterations = Math.ceil(timeoutMs / 500)
      for (let i = 0; i < maxIterations; i++) {
        if (ctx.abort.aborted) break
        yield* Effect.sleep("500 millis")
        const updated = yield* sessions.messages({ sessionID })
        const last = [...updated].reverse().find((m) => m.info.role === "assistant")
        if (last && isFinished(last)) {
          const sess = yield* sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(session)))
          return formatCompleted(sess, last)
        }
      }

      return {
        title: "Task check",
        metadata: {},
        output: `Task (${params.task_id}) timed out after ${timeoutMs}ms or was cancelled.`,
      }
    })

    return {
      description:
        "Check status and results of a background task. Use the task_id from the task tool output when run_in_background was true. Set block=true to wait for completion.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
