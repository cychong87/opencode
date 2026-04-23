import { describe, test, expect } from "bun:test"
import { GuardedClassifier, MockClassifier } from "@/agent/router/classifier"
import type { ClassifierInput } from "@/agent/router/types"

describe("GuardedClassifier", () => {
  const baseInput: ClassifierInput = {
    prompt: "test", firedSignalNames: [], timeoutMs: 1000,
    heuristicSummary: { taskArchetype: "mutating-broad", fileCount: 100, packageCount: 3 },
  }

  test("passes through on success", async () => {
    const inner = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "ok" })
    const guarded = new GuardedClassifier(inner, { maxCallsPerSession: 10, consecutiveFailuresToTrip: 5, cooldownMs: 100 })
    const result = await guarded.classify(baseInput)
    expect(result).not.toBeNull()
    expect(result!.decision).toBe("coordinator")
  })

  test("rate limit: returns null after maxCallsPerSession", async () => {
    const inner = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "ok" })
    const guarded = new GuardedClassifier(inner, { maxCallsPerSession: 2, consecutiveFailuresToTrip: 5, cooldownMs: 100 })
    await guarded.classify(baseInput)
    await guarded.classify(baseInput)
    const result = await guarded.classify(baseInput)
    expect(result).toBeNull()
    expect(guarded.lastFallbackReason).toBe("rate_limit")
  })

  test("circuit breaker: trips after N consecutive failures", async () => {
    const failing: any = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "" })
    failing.classify = async () => { throw new Error("network error") }
    const guarded = new GuardedClassifier(failing, { maxCallsPerSession: 100, consecutiveFailuresToTrip: 3, cooldownMs: 60000 })

    for (let i = 0; i < 3; i++) {
      await guarded.classify(baseInput)
    }
    const result = await guarded.classify(baseInput)
    expect(result).toBeNull()
    expect(guarded.lastFallbackReason).toBe("circuit_open")
  })

  test("success resets consecutive failure count", async () => {
    const inner = new MockClassifier({ decision: "single", confidence: "low", reason: "ok" })
    let callCount = 0
    const flaky: any = { classify: async () => {
      callCount++
      if (callCount <= 2) throw new Error("fail")
      return inner.classify({} as any)
    }}
    const guarded = new GuardedClassifier(flaky, { maxCallsPerSession: 100, consecutiveFailuresToTrip: 3, cooldownMs: 60000 })

    await guarded.classify(baseInput) // fail 1
    await guarded.classify(baseInput) // fail 2
    const r = await guarded.classify(baseInput) // success — resets counter
    expect(r).not.toBeNull()
    expect(guarded.lastFallbackReason).toBeNull()
  })

  test("lastFallbackReason resets on each call", async () => {
    const inner = new MockClassifier({ decision: "single", confidence: "low", reason: "ok" })
    const guarded = new GuardedClassifier(inner, { maxCallsPerSession: 10, consecutiveFailuresToTrip: 5, cooldownMs: 100 })
    const result = await guarded.classify(baseInput)
    expect(result).not.toBeNull()
    expect(guarded.lastFallbackReason).toBeNull()
  })

  test("circuit recovery: after cooldown, failure counter resets (half-open)", async () => {
    const failing: any = new MockClassifier({ decision: "coordinator", confidence: "high", reason: "" })
    failing.classify = async () => { throw new Error("fail") }
    // Short cooldown so we don't have to wait long
    const guarded = new GuardedClassifier(failing, { maxCallsPerSession: 100, consecutiveFailuresToTrip: 3, cooldownMs: 30 })

    // Trip the breaker
    for (let i = 0; i < 3; i++) await guarded.classify(baseInput)
    // Breaker open — next call is short-circuited
    expect((await guarded.classify(baseInput))).toBeNull()
    expect(guarded.lastFallbackReason).toBe("circuit_open")

    // Wait past cooldown
    await new Promise(r => setTimeout(r, 50))

    // First post-cooldown call attempts (not circuit_open), fails, counter starts fresh
    const r1 = await guarded.classify(baseInput)
    expect(r1).toBeNull()
    expect(guarded.lastFallbackReason).toBe("timeout")  // NOT circuit_open

    // Only 1 failure after reset — circuit should NOT be open yet
    const r2 = await guarded.classify(baseInput)
    expect(r2).toBeNull()
    expect(guarded.lastFallbackReason).toBe("timeout")  // still attempting
  })
})
