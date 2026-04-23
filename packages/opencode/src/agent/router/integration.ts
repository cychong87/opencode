import type { RoutingDecision, WorkspaceAnalyzer, LLMClassifier, HintBlock } from "./types"
import { route } from "../router"
import { shouldInherit } from "./inherit"
import { computeFingerprint } from "./fingerprint"
import { RouterSessionStore } from "./session-store"
import { ErrorBudgetTracker } from "./error-budget"
import {
  formatOverride, formatInherited, formatRouted,
  emitAnnounce, emitBanner, type AnnounceOptions,
} from "./announce"
import { renderHintBlock } from "./compose-prompt"

export interface SelectAgentInput {
  prompt: string
  workspaceRoot: string
  cwd: string
  modelId: string
  sessionId: string
  turnIndex: number
  userOverride?: string          // e.g. "coordinator", "plan", etc.
  analyzer: WorkspaceAnalyzer
  classifier?: LLMClassifier
  announceOpts?: AnnounceOptions
}

export interface SelectAgentResult {
  mode: "single" | "coordinator" | "other"
  agentName: string
  decision: RoutingDecision | null
  coordinatorPromptHints?: string   // rendered hint block to append to coordinator prompt
}

// Module-level singletons — one per process
const sessionStore = new RouterSessionStore()
const errorBudget = new ErrorBudgetTracker()

export async function selectAgentMode(input: SelectAgentInput): Promise<SelectAgentResult> {
  // 1. ANY explicit agent override → short-circuit
  if (input.userOverride) {
    if (input.userOverride === "coordinator") {
      // Still run analyzer for partition hints
      let hints: HintBlock | undefined
      try {
        const analysis = await input.analyzer.analyze(input.workspaceRoot)
        hints = {
          suggestedWorkerCount: Math.min(analysis.packageCount, 4),
          suggestedPartition: analysis.packages.map(p => [p + "/**"]),
          triggerReasons: ["manual override"],
        }
      } catch {
        // Analyzer failure on override path is non-fatal
      }

      const msg = formatOverride("coordinator")
      emitAnnounce(msg, input.announceOpts)

      return {
        mode: "coordinator",
        agentName: "coordinator",
        decision: null,
        coordinatorPromptHints: hints ? renderHintsForPrompt(hints) : undefined,
      }
    }
    // Non-coordinator override (plan, review, etc.)
    const msg = formatOverride(input.userOverride)
    emitAnnounce(msg, input.announceOpts)
    return { mode: "other", agentName: input.userOverride, decision: null }
  }

  // 2. Turn 2+ inheritance — with escape conditions
  const prior = sessionStore.get(input.sessionId)
  if (prior && input.turnIndex >= 2) {
    let currentFingerprint = ""
    try {
      currentFingerprint = await computeFingerprint(input.workspaceRoot)
    } catch { /* non-fatal */ }

    const inheritResult = shouldInherit({
      prompt: input.prompt,
      turnIndex: input.turnIndex,
      previousDecision: prior,
      currentFingerprint,
    })

    if (inheritResult.inherit) {
      const msg = formatInherited(prior)
      emitAnnounce(msg, input.announceOpts)
      return {
        mode: prior.mode,
        agentName: prior.mode === "coordinator" ? "coordinator" : "default",
        decision: prior,
      }
    }
    // Escape fired — fall through to full routing
  }

  // 3. Normal routing
  const decision = await route({
    prompt: input.prompt,
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    modelId: input.modelId,
    analyzer: input.analyzer,
    classifier: input.classifier,
  })

  // Track in error budget
  errorBudget.recordTurn(decision.fallbackPath)
  if (errorBudget.shouldShowBanner()) {
    emitBanner(errorBudget.getBannerMessage(), input.announceOpts)
    errorBudget.bannerShown()
  }

  // Announce
  const msg = formatRouted(decision)
  emitAnnounce(msg, input.announceOpts)

  // Persist for next turn's inheritance
  sessionStore.set(input.sessionId, decision)

  // Build coordinator prompt hints if coordinator mode
  let coordinatorPromptHints: string | undefined
  if (decision.mode === "coordinator") {
    const hints: HintBlock = {
      suggestedWorkerCount: decision.suggestedWorkerCount,
      suggestedPartition: decision.suggestedPartition,
      triggerReasons: decision.firedSignals,
    }
    coordinatorPromptHints = renderHintsForPrompt(hints)
  }

  return {
    mode: decision.mode,
    agentName: decision.mode === "coordinator" ? "coordinator" : "default",
    decision,
    coordinatorPromptHints,
  }
}

function renderHintsForPrompt(hints: HintBlock): string {
  return renderHintBlock(hints)
}

// Export for testing
export { sessionStore, errorBudget }
