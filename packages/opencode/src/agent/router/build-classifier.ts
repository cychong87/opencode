/**
 * Build a production LLMClassifier using a pre-resolved provider service.
 *
 * Takes Provider as a parameter (not a requirement) so the returned Effect
 * doesn't propagate Provider.Service as a new requirement upstream.
 *
 * Called from session/prompt.ts where the provider is already in closure scope.
 */
import { Effect, Exit } from "effect"
import { Provider } from "@/provider"
import { RealClassifier } from "./classifier-real"
import { GuardedClassifier } from "./classifier"
import weights from "./weights.json"
import type { LLMClassifier, ClassifierInput, ClassifierOutput } from "./types"

// Exposed for diagnostics (debug router command prints this)
export let LAST_RESOLVED_MODEL: { providerID: string; modelID: string } | null = null
export let LAST_CLASSIFIER_ERROR: string | null = null

// Adapter: GuardedClassifier returns null on fallback; LLMClassifier must never
// return null. Adapter throws so the router's try/catch falls through to single.
class GuardedAdapter implements LLMClassifier {
  constructor(private readonly guarded: GuardedClassifier) {}
  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    const result = await this.guarded.classify(input)
    if (result === null) {
      const reason = this.guarded.lastFallbackReason ?? "unknown"
      const innerMsg = this.guarded.lastErrorMessage
      LAST_CLASSIFIER_ERROR = innerMsg ? `${reason}: ${innerMsg}` : `fallback: ${reason}`
      throw new Error(`classifier ${reason}${innerMsg ? `: ${innerMsg}` : ""}`)
    }
    return result
  }
}

/**
 * Build a classifier using an already-resolved provider. Returns undefined if
 * tiebreaker is disabled or no small model is available.
 *
 * The `provider` arg has the `Provider.Interface` shape (from Provider.Service.of).
 */
export const buildClassifier = Effect.fnUntraced(function* (provider: Provider.Interface) {
  if (!weights.tiebreaker.enabled) return undefined
  const exit = yield* Effect.gen(function* () {
    let smallModelInfo: any

    // Model resolution priority:
    //   1. router/weights.json → tiebreaker.modelRef (explicit override, e.g. "anthropic/claude-haiku-4.5")
    //      For users who want to save cost by routing tiebreaker calls to a cheap model.
    //   2. The user's default model — the simplest, always-works path.
    //      Tradeoff: tiebreaker calls hit the main model (~$0.01-0.05 per uncertain turn).
    //      Benefit: zero setup, always authenticated, same latency profile as main flow.

    const explicitRef = weights.tiebreaker.modelRef as string | null
    if (explicitRef && typeof explicitRef === "string" && explicitRef.includes("/")) {
      const [providerID, ...modelParts] = explicitRef.split("/")
      const modelID = modelParts.join("/")
      try {
        smallModelInfo = yield* provider.getModel(providerID as any, modelID as any)
      } catch {
        smallModelInfo = undefined
      }
    } else if (explicitRef && typeof explicitRef === "string" && explicitRef.trim().length > 0) {
      // Non-null, non-empty, but malformed (missing "/") — silent fallback to the default
      // model would leave the user believing they had pinned a cheap model for tiebreaker
      // calls when they actually haven't. Surface the misconfiguration via the diagnostic
      // channel so `opencode debug router --full` prints it.
      LAST_CLASSIFIER_ERROR = `tiebreaker.modelRef "${explicitRef}" must be "providerID/modelID" — falling back to default model`
    }

    // Default: use the user's configured model — simplest UX, always works
    if (!smallModelInfo) {
      const defaultModel = yield* provider.defaultModel()
      try {
        smallModelInfo = yield* provider.getModel(defaultModel.providerID, defaultModel.modelID)
      } catch {
        smallModelInfo = undefined
      }
    }

    if (!smallModelInfo) return undefined
    LAST_RESOLVED_MODEL = { providerID: smallModelInfo.providerID, modelID: smallModelInfo.id }
    const language = yield* provider.getLanguage(smallModelInfo)
    const raw = new RealClassifier({ model: language, maxTokens: weights.tiebreaker.maxTokens })
    const guarded = new GuardedClassifier(raw, {
      maxCallsPerSession: weights.tiebreaker.maxCallsPerSession,
      consecutiveFailuresToTrip: weights.tiebreaker.circuitBreaker.consecutiveFailuresToTrip,
      cooldownMs: weights.tiebreaker.circuitBreaker.cooldownMs,
    })
    return new GuardedAdapter(guarded) as LLMClassifier | undefined
  }).pipe(Effect.exit)
  return Exit.isSuccess(exit) ? exit.value : undefined
})
