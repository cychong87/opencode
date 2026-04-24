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
  public lastErrorMessage: string | null = null

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

    // Half-open: if we just exited the cooldown, reset the failure counter
    // so a single success closes the circuit and a single failure re-trips only after
    // consecutiveFailuresToTrip more failures (not instantly).
    if (this.circuitOpenUntil > 0 && this.circuitOpenUntil <= Date.now()) {
      this.circuitOpenUntil = 0
      this.consecutiveFailures = 0
    }

    this.callCount++
    try {
      const result = await this.inner.classify(input)
      this.consecutiveFailures = 0
      this.lastErrorMessage = null
      return result
    } catch (err) {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= this.config.consecutiveFailuresToTrip) {
        this.circuitOpenUntil = Date.now() + this.config.cooldownMs
      }
      this.lastErrorMessage = err instanceof Error ? err.message : String(err)
      // Classify the error type so telemetry/debug output is more useful than
      // "timeout" for every non-timeout failure (auth, network, malformed, etc.)
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
      if (msg.includes("timeout")) this.lastFallbackReason = "timeout"
      else if (msg.includes("unauthor") || msg.includes("401") || msg.includes("403") || msg.includes("api key")) this.lastFallbackReason = "auth_error"
      else if (msg.includes("network") || msg.includes("fetch") || msg.includes("econn")) this.lastFallbackReason = "network_error"
      else if (msg.includes("malformed") || msg.includes("parse")) this.lastFallbackReason = "malformed"
      else this.lastFallbackReason = "error"
      return null
    }
  }
}
