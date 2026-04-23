/**
 * Real LLM-backed classifier. Issues a short, timeout-bounded generateText call
 * to a small/cheap model and parses the output as classifier JSON.
 *
 * Constructed ahead of time by wire.ts (which resolves the small model via
 * Provider.getSmallModel()) and passed into selectAgentMode as input.classifier.
 *
 * The GuardedClassifier wrapper (in classifier.ts) adds circuit-breaker + rate-limit
 * semantics on top. This class is the raw provider-bound caller.
 */
import { generateText, type LanguageModel } from "ai"
import type { LLMClassifier, ClassifierInput, ClassifierOutput } from "./types"
import { parseClassifierOutput } from "./classifier-parse"
import TIEBREAKER_PROMPT from "../prompt/tiebreaker.txt"

export interface RealClassifierConfig {
  /** Resolved language model from Provider.getSmallModel() + provider.getLanguage(). */
  model: LanguageModel
  /** Max tokens for the classifier response. Default 150. */
  maxTokens?: number
}

export class RealClassifier implements LLMClassifier {
  private readonly config: RealClassifierConfig

  constructor(config: RealClassifierConfig) {
    this.config = config
  }

  async classify(input: ClassifierInput): Promise<ClassifierOutput> {
    const userMessage = buildUserMessage(input)
    const maxTokens = this.config.maxTokens ?? 150

    // Race the generateText call against a timeout.
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("classifier timeout")), input.timeoutMs),
    )

    const genPromise = generateText({
      model: this.config.model,
      system: TIEBREAKER_PROMPT,
      prompt: userMessage,
      maxOutputTokens: maxTokens,
      temperature: 0,
    }).then((r) => r.text)

    const raw = await Promise.race([genPromise, timeoutPromise])

    // Try JSON parse first; fall back to regex on parse failure.
    try {
      return parseClassifierOutput(raw, "json")
    } catch {
      // Retry once with error context — provider sometimes recovers with hint.
      try {
        return parseClassifierOutput(raw, "regex")
      } catch {
        throw new Error(`classifier malformed output: ${raw.slice(0, 100)}`)
      }
    }
  }
}

function buildUserMessage(input: ClassifierInput): string {
  return [
    `Task: "${input.prompt}"`,
    `Fired signals: ${input.firedSignalNames.join(", ") || "(none)"}`,
    `Task archetype: ${input.heuristicSummary.taskArchetype}`,
    `Workspace: ${input.heuristicSummary.fileCount} files, ${input.heuristicSummary.packageCount} packages`,
  ].join("\n")
}
