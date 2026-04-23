import type { LLMClassifier, ClassifierInput, ClassifierOutput } from "./types"

export class MockClassifier implements LLMClassifier {
  private readonly output: ClassifierOutput
  constructor(output: ClassifierOutput) { this.output = output }
  async classify(_input: ClassifierInput): Promise<ClassifierOutput> { return this.output }
}

export interface GuardedConfig {
  maxCallsPerSession: number
  consecutiveFailuresToTrip: number
  cooldownMs: number
}

// GuardedClassifier wraps an LLMClassifier with circuit breaker + rate limiting.
// It does NOT implement LLMClassifier because its classify() returns null on fallback.
export class GuardedClassifier {
  private readonly inner: LLMClassifier
  private readonly config: GuardedConfig
  private callCount = 0
  private consecutiveFailures = 0
  private circuitOpenUntil = 0
  public lastFallbackReason: string | null = null

  constructor(inner: LLMClassifier, config: GuardedConfig) {
    this.inner = inner
    this.config = config
  }

  async classify(input: ClassifierInput): Promise<ClassifierOutput | null> {
    this.lastFallbackReason = null

    if (this.callCount >= this.config.maxCallsPerSession) {
      this.lastFallbackReason = "rate_limit"
      return null
    }

    if (this.circuitOpenUntil > Date.now()) {
      this.lastFallbackReason = "circuit_open"
      return null
    }

    this.callCount++
    try {
      const result = await this.inner.classify(input)
      this.consecutiveFailures = 0
      return result
    } catch {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= this.config.consecutiveFailuresToTrip) {
        this.circuitOpenUntil = Date.now() + this.config.cooldownMs
      }
      this.lastFallbackReason = "timeout"
      return null
    }
  }
}
