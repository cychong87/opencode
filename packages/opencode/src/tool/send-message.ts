import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createMailbox, type MessageType } from "../mailbox"
import { InstanceState } from "../effect"

const id = "send_message"

const parameters = z.object({
  to: z
    .string()
    .describe('Recipient agent ID in "name@team" format, or "*" for broadcast to all team members'),
  message: z.string().describe("Message content to send"),
  type: z
    .enum([
      "plain",
      "task_assignment",
      "idle_notification",
      "shutdown_request",
      "shutdown_approved",
      "shutdown_rejected",
      "plan_approval_request",
      "plan_approval_response",
    ])
    .optional()
    .describe("Message type. Default: plain"),
  summary: z.string().optional().describe("5-10 word preview of the message"),
})

export const SendMessageTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description:
        'Send a message to a teammate by their agent ID (format: "name@team"). Use "*" as the to field to broadcast to all team members (requires team context).',
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const mailbox = createMailbox(dir)
          const msgType: MessageType = params.type ?? "plain"
          const from = (ctx.extra?.agentID as string | undefined) ?? ctx.agent

          if (params.to === "*") {
            return {
              title: "Broadcast",
              metadata: {},
              output:
                "Broadcast (to: *) requires team context. Use spawn_worker to create a team first, then broadcast via the team tools.",
            }
          }

          yield* Effect.promise(() =>
            mailbox.send({
              from,
              to: params.to,
              type: msgType,
              content: params.message,
              summary: params.summary,
            }),
          )

          return {
            title: "Message sent",
            metadata: {},
            output: `Message sent to ${params.to}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
