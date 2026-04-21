import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { type TaskPromptOps } from "./task"
import { createTeamService, type TeamMember } from "../team"
import { createMailbox, formatAgentID } from "../mailbox"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionID, MessageID } from "../session/schema"
import { InstanceState } from "../effect"

const id = "spawn_worker"

const parameters = z.object({
  name: z.string().describe('Worker name (e.g., "researcher", "implementer")'),
  prompt: z.string().describe("Initial task/instructions for the worker"),
  team_name: z.string().describe("Team to add the worker to"),
  agent_type: z.string().optional().describe("Agent type for the worker (e.g., 'general', 'explore'). Default: 'general'"),
})

export const SpawnWorkerTool = Tool.define(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const run = Effect.fn("SpawnWorkerTool.execute")(function* (
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      const dir = yield* InstanceState.directory
      const teams = createTeamService(dir)
      const mailbox = createMailbox(dir)
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops)
        return {
          title: "Spawn failed",
          metadata: {} as Record<string, unknown>,
          output: "spawn_worker requires promptOps context. This tool must be called from within an active session.",
        }

      const agentType = params.agent_type ?? "general"
      const agentID = formatAgentID(params.name, params.team_name)
      const coordinatorID = formatAgentID("coordinator", params.team_name)

      // Create a child session for this worker
      const workerSession = yield* sessions.create({
        parentID: ctx.sessionID,
        title: `${params.name} worker (@${agentType})`,
      })

          // Register member in team file
          const member: TeamMember = {
            agentID,
            name: params.name,
            role: "worker",
            agent: agentType,
            sessionID: workerSession.id,
            status: "active",
            joinedAt: Date.now(),
          }
          yield* Effect.promise(() => teams.addMember(params.team_name, member))

          // Resolve model from parent message
          const msg = yield* Effect.sync(() =>
            MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }),
          )
          const model =
            msg?.info?.role === "assistant"
              ? { modelID: msg.info.modelID, providerID: msg.info.providerID }
              : undefined

          // Fork the worker lifecycle loop in the background
          ops.fork(
            Effect.gen(function* () {
              let currentPrompt: string | undefined = params.prompt

              while (true) {
                if (currentPrompt) {
                  yield* Effect.promise(() => teams.updateStatus(params.team_name, agentID, "active"))

                  const parts = yield* ops.resolvePromptParts(currentPrompt)
                  yield* ops.prompt({
                    messageID: MessageID.ascending(),
                    sessionID: workerSession.id,
                    ...(model ? { model } : {}),
                    agent: agentType,
                    parts,
                  })

                  currentPrompt = undefined
                  yield* Effect.promise(() => teams.updateStatus(params.team_name, agentID, "idle"))

                  // Send idle notification to coordinator
                  yield* Effect.promise(() =>
                    mailbox.send({
                      from: agentID,
                      to: coordinatorID,
                      type: "idle_notification",
                      content: "Task completed, waiting for next assignment",
                      summary: `${params.name} completed task`,
                    }),
                  )
                }

                // Poll mailbox for next action (500ms interval)
                yield* Effect.sleep("500 millis")

                const msgs = yield* Effect.promise(() => mailbox.readUnread(agentID))
                for (const inboxMsg of msgs) {
                  yield* Effect.promise(() => mailbox.markRead(agentID, inboxMsg.id))

                  if (inboxMsg.type === "shutdown_request") {
                    yield* Effect.promise(() => teams.updateStatus(params.team_name, agentID, "completed"))
                    return // exit loop
                  }

                  if (inboxMsg.type === "task_assignment" || inboxMsg.type === "plain") {
                    currentPrompt = inboxMsg.content
                    break // break inner for, continue outer while
                  }
                }
              }
            }).pipe(
              Effect.catchCause(() =>
                Effect.promise(async () => {
                  await teams.updateStatus(params.team_name, agentID, "failed").catch(() => {})
                }).pipe(Effect.andThen(Effect.logError(`Worker ${agentID} failed`))),
              ),
            ),
          )

      return {
        title: `Worker spawned: ${params.name}`,
        metadata: { agentID, sessionID: workerSession.id } as Record<string, unknown>,
        output: [
          `Worker "${params.name}" spawned in team "${params.team_name}".`,
          `Agent ID: ${agentID}`,
          `Session ID: ${workerSession.id}`,
          `Agent type: ${agentType}`,
          "",
          "The worker is now executing the initial task.",
          "Check your mailbox for idle_notification when it finishes.",
          "Send task_assignment messages to assign new work.",
          "Use terminate_worker to shut it down.",
        ].join("\n"),
      }
    })

    return {
      description:
        "Spawn a new worker agent in the team. The worker runs in the background with an idle/resume lifecycle — it executes the initial task, sends an idle notification, then waits for new tasks via mailbox.",
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
