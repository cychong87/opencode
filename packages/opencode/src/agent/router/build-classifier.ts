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

// Adapter: GuardedClassifier returns null on fallback; LLMClassifier must never
// return null. Adapter throws so the router's try/catch falls through to single.
class GuardedAdapter implements LLMClassifier {
  constructor(private readonly guarded: GuardedClassifier) {}
  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    const result = await this.guarded.classify(input)
    if (result === null) {
      throw new Error(`classifier fallback: ${this.guarded.lastFallbackReason ?? "unknown"}`)
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
    const defaultModel = yield* provider.defaultModel()
    const smallModelInfo = yield* provider.getSmallModel(defaultModel.providerID)
    if (!smallModelInfo) return undefined
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
