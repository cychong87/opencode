import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createMailbox, type Message } from "../mailbox"
import { InstanceState } from "../effect"

const id = "check_mailbox"

const parameters = z.object({
  agent_id: z
    .string()
    .describe('Your agent ID in "name@team" format. Required to know which inbox to check.'),
  mark_read: z
    .boolean()
    .optional()
    .describe("Mark messages as read after viewing. Default: false. Set to true only after you have processed the messages."),
})

function formatMessages(messages: Message[]): string {
  if (messages.length === 0) return "No new messages."
  const lines: string[] = [`${messages.length} new message(s):\n`]
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    lines.push(`--- Message ${i + 1} ---`)
    lines.push(`From: ${msg.from}`)
    lines.push(`Type: ${msg.type}`)
    lines.push(`Time: ${new Date(msg.timestamp).toISOString()}`)
    if (msg.summary) lines.push(`Summary: ${msg.summary}`)
    lines.push(`Content:\n${msg.content}\n`)
  }
  return lines.join("\n")
}

export const CheckMailboxTool = Tool.define(
  id,
  Effect.gen(function* () {
    return {
      description:
        "Check for new unread messages in your inbox. Provide your agent_id to identify which inbox to read.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const dir = yield* InstanceState.directory
          const mailbox = createMailbox(dir)
          const agentID = params.agent_id
          const markRead = params.mark_read === true

          const messages = yield* Effect.promise(() => mailbox.readUnread(agentID))
          const output = formatMessages(messages)

          if (markRead && messages.length > 0) {
            yield* Effect.promise(() => mailbox.markAllRead(agentID))
          }

          return {
            title: `${messages.length} messages`,
            metadata: {},
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
