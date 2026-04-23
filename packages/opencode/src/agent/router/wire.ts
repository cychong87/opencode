/**
 * Effect-wrapped router entry point for integration with opencode's session/turn pipeline.
 * Bridges the Promise-based selectAgentMode() into the Effect-based session flow.
 *
 * Used from `session/prompt.ts:createUserMessage` to auto-route user turns.
 * All required services are passed as params so this function doesn't add new
 * Effect context requirements (keeps upstream signatures stable).
 */
import { Effect, Exit } from "effect"
import { selectAgentMode, type SelectAgentResult } from "./integration"
import { RealWorkspaceAnalyzer } from "./workspace-analyzer"
import type { LLMClassifier } from "./types"

export interface AutoRouteInput {
  /** Full user prompt text (concatenated from all text parts of the message). */
  prompt: string
  sessionID: string
  /** Workspace root directory (caller resolves from InstanceState.context). */
  workspaceRoot: string
  /** 1-indexed turn count (1 = first turn). */
  turnIndex: number
  /** Explicit --agent flag if user provided one, else undefined. */
  userOverride?: string
  /** Pre-resolved LLM classifier for the uncertain band, or undefined to disable. */
  classifier?: LLMClassifier
}

/**
 * Auto-route a turn. Never fails — on any error returns `null`, and the caller
 * falls back to opencode's default agent selection.
 */
export const autoRoute = Effect.fnUntraced(function* (input: AutoRouteInput) {
  const exit = yield* Effect.tryPromise(() =>
    selectAgentMode({
      prompt: input.prompt,
      workspaceRoot: input.workspaceRoot,
      cwd: input.workspaceRoot,
      modelId: "",
      sessionId: input.sessionID,
      turnIndex: input.turnIndex,
      userOverride: input.userOverride,
      analyzer: new RealWorkspaceAnalyzer(),
      classifier: input.classifier,
    }),
  ).pipe(Effect.exit)
  if (Exit.isSuccess(exit)) return exit.value as SelectAgentResult
  return null
})

/**
 * Extract the concatenated text content from a PromptInput's parts array.
 * Non-text parts (files, etc.) are skipped — the router only looks at prose.
 */
export function extractPromptText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join(" ")
    .trim()
}
