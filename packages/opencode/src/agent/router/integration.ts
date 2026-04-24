import type {
  RoutingDecision, WorkspaceAnalyzer, LLMClassifier, HintBlock,
  TelemetryRecord, TaskArchetype, DecisionSource,
} from "./types"
import { route } from "../router"
import { shouldInherit } from "./inherit"
import { computeFingerprint } from "./fingerprint"
import { classifyArchetype, computeComposite } from "./scorer"
import { RouterSessionStore } from "./session-store"
import { ErrorBudgetTracker } from "./error-budget"
import { TelemetryWriter, opportunisticCleanup } from "./telemetry"
import { computeRouterDecisionVersion, sha256Hex } from "./version"
import {
  formatOverride, formatInherited, formatRouted,
  emitAnnounce, emitBanner, type AnnounceOptions,
} from "./announce"
import defaultWeights from "./weights.json"
import TIEBREAKER_PROMPT from "../prompt/tiebreaker.txt"

export interface SelectAgentInput {
  prompt: string
  workspaceRoot: string
  cwd: string
  modelId: string
  sessionId: string
  turnIndex: number
  userOverride?: string
  analyzer: WorkspaceAnalyzer
  classifier?: LLMClassifier
  announceOpts?: AnnounceOptions
  /** If true, skip telemetry writes (used in tests). Defaults to false. */
  suppressTelemetry?: boolean
}

export interface SelectAgentResult {
  mode: "single" | "coordinator" | "other"
  agentName: string
  decision: RoutingDecision | null
  /** Raw hints — caller composes into coordinator system prompt via composeCoordinatorPrompt. */
  hints?: HintBlock
  /**
   * Human-readable announce line describing the routing decision.
   * Callers should surface this in the UI (e.g. as a synthetic text part, toast, or stderr).
   * Examples:
   *   "→ Routing: coordinator · 5 packages, 500 files"
   *   "→ Routing: single · single-package edit"
   *   "→ Routing: coordinator (manual override)"
   */
  announceText: string
}

// Module-level singletons — one per process
const sessionStore = new RouterSessionStore()
const errorBudget = new ErrorBudgetTracker()

// Precomputed at module load — tiebreaker prompt hash never changes at runtime
const TIEBREAKER_PROMPT_SHA = sha256Hex(TIEBREAKER_PROMPT).slice(0, 12)
const ROUTER_DECISION_VERSION = computeRouterDecisionVersion(TIEBREAKER_PROMPT_SHA)

// Opportunistic cleanup — runs once per process, not blocking
let cleanupScheduled = false
function scheduleCleanup(workspaceRoot: string): void {
  if (cleanupScheduled) return
  cleanupScheduled = true
  // Fire-and-forget — don't await
  opportunisticCleanup(workspaceRoot, 30).catch(() => { /* non-fatal */ })
}

export async function selectAgentMode(input: SelectAgentInput): Promise<SelectAgentResult> {
  scheduleCleanup(input.workspaceRoot)

  // 1. ANY explicit agent override → short-circuit
  if (input.userOverride) {
    if (input.userOverride === "coordinator") {
      let hints: HintBlock | undefined
      try {
        const analysis = await input.analyzer.analyze(input.workspaceRoot)
        hints = {
          suggestedWorkerCount: Math.min(analysis.packageCount, 4),
          suggestedPartition: analysis.packages.map(p => [p + "/**"]),
          triggerReasons: ["manual override"],
        }
      } catch { /* non-fatal */ }

      const announceText = formatOverride("coordinator")
      emitAnnounce(announceText, input.announceOpts)
      await writeTelemetry(input, "override", null, "mutating-narrow", null)
      return {
        mode: "coordinator",
        agentName: "coordinator",
        decision: null,
        hints,
        announceText,
      }
    }
    const announceText = formatOverride(input.userOverride)
    emitAnnounce(announceText, input.announceOpts)
    await writeTelemetry(input, "override", null, "mutating-narrow", null)
    return { mode: "other", agentName: input.userOverride, decision: null, announceText }
  }

  // 2. Turn 2+ inheritance
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
      const announceText = formatInherited(prior)
      emitAnnounce(announceText, input.announceOpts)
      await writeTelemetry(input, "inherited", prior, classifyArchetype(input.prompt, defaultWeights.mutationVerbs), null)
      return {
        mode: prior.mode,
        agentName: prior.mode === "coordinator" ? "coordinator" : "default",
        decision: prior,
        announceText,
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

  errorBudget.recordTurn(decision.fallbackPath)
  if (errorBudget.shouldShowBanner()) {
    emitBanner(errorBudget.getBannerMessage(), input.announceOpts)
    errorBudget.bannerShown()
  }

  const announceText = formatRouted(decision)
  emitAnnounce(announceText, input.announceOpts)
  sessionStore.set(input.sessionId, decision)
  await writeTelemetry(input, "routed", decision, classifyArchetype(input.prompt, defaultWeights.mutationVerbs), decision.fallbackPath)

  let hints: HintBlock | undefined
  if (decision.mode === "coordinator") {
    hints = {
      suggestedWorkerCount: decision.suggestedWorkerCount,
      suggestedPartition: decision.suggestedPartition,
      triggerReasons: decision.firedSignals,
    }
  }

  return {
    mode: decision.mode,
    agentName: decision.mode === "coordinator" ? "coordinator" : "default",
    decision,
    hints,
    announceText,
  }
}

/**
 * Write a telemetry record to the daily JSONL file. Never throws —
 * telemetry failure must never break a user's turn.
 */
async function writeTelemetry(
  input: SelectAgentInput,
  source: DecisionSource,
  decision: RoutingDecision | null,
  archetype: TaskArchetype,
  fallbackPath: string | null,
): Promise<void> {
  if (input.suppressTelemetry) return
  try {
    const writer = new TelemetryWriter(input.workspaceRoot)
    const promptSha = sha256Hex(input.prompt).slice(0, 16)

    // For routed decisions, compute scores from decision signals.
    // For override/inherited, we don't have fresh scores — zero them out.
    let scores = { prompt: 0, codebase: 0, primary: 0, secondary: 0 }
    if (decision) {
      const composite = computeComposite(decision.signals.promptScore, decision.signals.codebaseScore)
      scores = {
        prompt: decision.signals.promptScore,
        codebase: decision.signals.codebaseScore,
        primary: composite.primary,
        secondary: composite.secondary,
      }
    }

    const record: TelemetryRecord = {
      ts: new Date().toISOString(),
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      source,
      promptSha,
      workspaceFingerprint: decision?.workspaceFingerprint ?? "",
      routerDecisionVersion: ROUTER_DECISION_VERSION,
      firedSignalNames: decision?.firedSignals ?? [],
      taskArchetype: archetype,
      scores,
      classifier: {
        invoked: decision?.signals.llmTiebreakerUsed ?? false,
        latencyMs: decision?.signals.llmTiebreakerLatencyMs,
        failureMode: fallbackPath,
      },
      finalDecision: {
        mode: decision?.mode ?? (source === "override" ? "coordinator" : "single"),
        confidence: decision?.confidence ?? "high",
      },
      fallbackPath,
    }
    await writer.write(record)
  } catch { /* non-fatal */ }
}

export { sessionStore, errorBudget, ROUTER_DECISION_VERSION, TIEBREAKER_PROMPT_SHA }
